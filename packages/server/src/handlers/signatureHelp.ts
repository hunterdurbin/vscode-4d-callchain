import {
  Connection,
  ParameterInformation,
  SignatureHelp,
  SignatureHelpParams,
  SignatureInformation,
  TextDocuments
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import * as path from "path";
import { CallGraph, SymbolKind, SymbolRecord } from "@4d/core";
import { ServerState } from "../state";
import { memberByOwner, membersOfClass } from "./memberWalk";

interface CallContext {
  callee: SymbolRecord | undefined;
  /** Zero-based comma index between the opening `(` and the cursor. */
  activeParameter: number;
}

/** Invocable kinds that can produce a signature. */
const INVOCABLE_KINDS = new Set<SymbolKind>([
  SymbolKind.ProjectMethod,
  SymbolKind.DatabaseMethod,
  SymbolKind.ClassFunction,
  SymbolKind.ClassConstructor,
  SymbolKind.ClassGetter,
  SymbolKind.ClassSetter,
  SymbolKind.ComponentMethod
]);

export function registerSignatureHelpHandler(
  state: ServerState,
  connection: Connection,
  documents: TextDocuments<TextDocument>
): void {
  connection.onSignatureHelp((params: SignatureHelpParams): SignatureHelp | null => {
    const graph = state.graph;
    if (!graph) return null;
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const ctx = resolveCallContext(graph, doc, params);
    if (!ctx?.callee) return null;
    // Clamp activeParameter to the variadic tail when present — so the
    // editor keeps highlighting "...rest" for any arg position beyond
    // the fixed params.
    const calleeParams = ctx.callee.params ?? [];
    let active = ctx.activeParameter;
    const lastIdx = calleeParams.length - 1;
    if (lastIdx >= 0 && calleeParams[lastIdx].variadic && active > lastIdx) {
      active = lastIdx;
    }
    return {
      signatures: [signatureFor(ctx.callee)],
      activeSignature: 0,
      activeParameter: active
    };
  });
}

function signatureFor(sym: SymbolRecord): SignatureInformation {
  const params = sym.params ?? [];
  const parts = params.map((p) => {
    // Variadic param: render as `…$rest : Type` so the editor's hover
    // makes the "any number of args" semantics visible. Name comes from
    // mergeCompilerParamsWithDeclare as the literal "...rest".
    if (p.variadic) {
      return p.type ? `…${p.name} : ${p.type}` : `…${p.name}`;
    }
    return p.type ? `$${p.name} : ${p.type}` : `$${p.name}`;
  });
  const ret = sym.returnType ? ` : ${sym.returnType}` : "";
  const label = `${sym.name}(${parts.join("; ")})${ret}`;
  // Build ParameterInformation entries with character offsets into the label
  // so the editor can highlight the active parameter.
  const paramInfos: ParameterInformation[] = [];
  let cursor = sym.name.length + 1; // past `Name(`
  for (let i = 0; i < params.length; i++) {
    const text = parts[i];
    const start = cursor;
    const end = cursor + text.length;
    paramInfos.push({ label: [start, end] });
    cursor = end + 2; // `; `
  }
  return {
    label,
    parameters: paramInfos,
    documentation: sym.ownerClass ? `Member of ${sym.ownerClass}` : undefined
  };
}

function resolveCallContext(
  graph: CallGraph,
  doc: TextDocument,
  params: SignatureHelpParams
): CallContext | undefined {
  // Walk backwards from the cursor across all preceding text to find the
  // unmatched opening `(`. Multi-line calls supported.
  const offset = doc.offsetAt(params.position);
  const text = doc.getText().slice(0, offset);
  const parenInfo = findUnmatchedOpenParen(text);
  if (!parenInfo) return undefined;

  const calleeEnd = parenInfo.openIndex; // position of `(`
  // Skip whitespace between the identifier and `(`.
  let i = calleeEnd - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return undefined;
  const identEnd = i + 1;
  while (i >= 0 && /[A-Za-z0-9_]/.test(text[i])) i--;
  const identStart = i + 1;
  if (identStart === identEnd) return undefined;
  const name = text.slice(identStart, identEnd);

  // Detect dotted prefix (member access). Look at what's just before identStart.
  let dotPrefix: string | undefined;
  if (text[identStart - 1] === ".") {
    let j = identStart - 1;
    // Walk back across `.\w+` segments.
    while (j > 0 && (text[j] === "." || /[A-Za-z0-9_]/.test(text[j]))) j--;
    if (text[j] === "." || /[A-Za-z0-9_]/.test(text[j])) j = j;
    else j++;
    dotPrefix = text.slice(j, identStart - 1);
  }

  const callee = resolveCallee(graph, name, dotPrefix, doc.uri);

  // Count top-level commas between parenInfo.openIndex + 1 and the cursor.
  const inside = text.slice(parenInfo.openIndex + 1);
  const activeParameter = countTopLevelCommas(inside);

  return { callee, activeParameter };
}

function resolveCallee(
  graph: CallGraph,
  name: string,
  dotPrefix: string | undefined,
  uri: string
): SymbolRecord | undefined {
  // `This.method` → look up in the file's class.
  if (dotPrefix === "This") {
    const className = classFromUri(uri);
    if (!className) return undefined;
    return membersOfClass(graph, className).find(
      (s) => s.name.toLowerCase() === name.toLowerCase()
    );
  }
  // `cs.NS.Class.method` (3-segment) or `cs.Class.method` (2-segment).
  if (dotPrefix && dotPrefix.startsWith("cs.")) {
    const fq = dotPrefix; // owner class identifier excluding the final member
    return memberByOwner(graph, fq, name);
  }
  // Bare project class member: `Foo.method` where Foo is a project class name.
  if (dotPrefix) {
    const cls = graph.byName(dotPrefix).find((s) => s.kind === SymbolKind.Class);
    if (cls) {
      return membersOfClass(graph, cls.name).find(
        (s) => s.name.toLowerCase() === name.toLowerCase()
      );
    }
    // Otherwise we don't have type info for the prefix (e.g. `$x.method`) —
    // skip silently. C.4's local inference can be added here later.
    return undefined;
  }
  // Free identifier — match invocable symbols.
  return graph
    .byName(name)
    .find((s) => INVOCABLE_KINDS.has(s.kind));
}

function findUnmatchedOpenParen(text: string): { openIndex: number } | undefined {
  // Scan right-to-left tracking close/open balance. Skip past strings and
  // line/block comments — they don't contribute to call argument structure.
  // For simplicity we strip strings + comments forward, then re-scan.
  const stripped = stripStringsAndComments(text);
  let depth = 0;
  for (let i = stripped.length - 1; i >= 0; i--) {
    const c = stripped[i];
    if (c === ")") depth++;
    else if (c === "(") {
      if (depth === 0) return { openIndex: i };
      depth--;
    }
  }
  return undefined;
}

function countTopLevelCommas(inside: string): number {
  // Count `,` and `;` (4D uses `;` as the argument separator) at top depth.
  const stripped = stripStringsAndComments(inside);
  let depth = 0;
  let n = 0;
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && (c === ";" || c === ",")) n++;
  }
  return n;
}

/**
 * Replace string literals, line comments, and block comments with spaces of
 * equal length so character offsets are preserved.
 */
function stripStringsAndComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") {
      // Line comment to next newline.
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) {
        for (; i < text.length; i++) out += text[i] === "\n" ? "\n" : " ";
        continue;
      }
      for (let k = i; k < end + 2; k++) out += text[k] === "\n" ? "\n" : " ";
      i = end + 2;
      continue;
    }
    if (ch === '"') {
      out += " ";
      i++;
      while (i < text.length) {
        if (text[i] === '"' && text[i + 1] === '"') { out += "  "; i += 2; continue; }
        if (text[i] === '"') { out += " "; i++; break; }
        out += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function classFromUri(uri: string): string | undefined {
  try {
    const fsPath = URI.parse(uri).fsPath;
    if (!fsPath.endsWith(".4dm")) return undefined;
    if (!/[\\/]Classes[\\/]/.test(fsPath)) return undefined;
    return path.basename(fsPath, ".4dm");
  } catch {
    return undefined;
  }
}
