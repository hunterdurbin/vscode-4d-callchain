import {
  Connection,
  CompletionItem,
  CompletionItemKind,
  CompletionList,
  CompletionParams,
  CompletionTriggerKind,
  InsertTextFormat,
  TextDocuments
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import * as path from "path";
import {
  BUILTIN_TYPE_API,
  CallGraph,
  PARAM_ENTITY,
  PARAM_SELECTION,
  SymbolKind,
  SymbolRecord,
  findEnclosingFunction,
  inferLocals,
  normalizeLocalType,
  splitBuiltin
} from "@4d/core";
import { ServerState } from "../state";

const MAX_FREE = 200;
const MAX_MEMBERS = 300;
const MIN_FREE_PREFIX = 1;

/** Kinds eligible for free-identifier completion. */
const FREE_KINDS = new Set<SymbolKind>([
  SymbolKind.ProjectMethod,
  SymbolKind.DatabaseMethod,
  SymbolKind.Class,
  SymbolKind.Constant,
  SymbolKind.BuiltinConstant,
  SymbolKind.ProcessVariable,
  SymbolKind.InterprocessVariable,
  SymbolKind.Builtin,
  SymbolKind.PluginCommand,
  SymbolKind.ComponentMethod
]);

/** Kinds that surface under a class on member completion. */
const CLASS_MEMBER_KINDS = new Set<SymbolKind>([
  SymbolKind.ClassFunction,
  SymbolKind.ClassConstructor,
  SymbolKind.ClassGetter,
  SymbolKind.ClassSetter
]);

interface FreeContext { kind: "free"; prefix: string; }
interface ThisContext { kind: "this"; }
interface CsContext { kind: "cs"; first: string; }
interface CsNsContext { kind: "csns"; namespace: string; className: string; }
interface VarContext { kind: "var"; variable: string; }
type Context = FreeContext | ThisContext | CsContext | CsNsContext | VarContext | undefined;

/** Parse the line text up to the cursor and figure out what's being typed. */
function parseContext(linePrefix: string): Context {
  // Member access patterns (most specific first).
  const csNs = linePrefix.match(/\bcs\.([\w_]+)\.([\w_]+)\.$/);
  if (csNs) return { kind: "csns", namespace: csNs[1], className: csNs[2] };
  const cs = linePrefix.match(/\bcs\.([\w_]+)\.$/);
  if (cs) return { kind: "cs", first: cs[1] };
  const thisDot = linePrefix.match(/\bThis\.$/);
  if (thisDot) return { kind: "this" };
  const varDot = linePrefix.match(/\$([\w_]+)\.$/);
  if (varDot) return { kind: "var", variable: varDot[1] };

  // Free identifier — the prefix is the word being typed (alphanumerics +
  // underscore, but not crossing a `.` or `$`).
  const trailing = linePrefix.match(/([A-Za-z_][\w_]*)$/);
  const prefix = trailing ? trailing[1] : "";
  if (prefix.length < MIN_FREE_PREFIX) return undefined;
  return { kind: "free", prefix };
}

function toCompletionKind(k: SymbolKind): CompletionItemKind {
  switch (k) {
    case SymbolKind.ProjectMethod:
    case SymbolKind.DatabaseMethod:
    case SymbolKind.PluginCommand:
    case SymbolKind.ComponentMethod:
    case SymbolKind.Builtin:
      return CompletionItemKind.Function;
    case SymbolKind.Class:
      return CompletionItemKind.Class;
    case SymbolKind.ClassFunction:
      return CompletionItemKind.Method;
    case SymbolKind.ClassConstructor:
      return CompletionItemKind.Constructor;
    case SymbolKind.ClassGetter:
    case SymbolKind.ClassSetter:
      return CompletionItemKind.Property;
    case SymbolKind.Constant:
    case SymbolKind.BuiltinConstant:
      return CompletionItemKind.Constant;
    case SymbolKind.ProcessVariable:
    case SymbolKind.InterprocessVariable:
      return CompletionItemKind.Variable;
    default:
      return CompletionItemKind.Text;
  }
}

function detail(s: SymbolRecord): string | undefined {
  if (s.ownerClass) return s.ownerClass;
  if (s.ownerPlugin) return `Plugin · ${s.ownerPlugin}`;
  if (s.ownerComponent) return `Component · ${s.ownerComponent}`;
  if (s.constantValue !== undefined) return s.constantValue;
  if (s.variableType) return s.variableType;
  return s.kind;
}

function toItem(s: SymbolRecord): CompletionItem {
  return {
    label: s.name,
    kind: toCompletionKind(s.kind),
    detail: detail(s),
    data: { id: s.id }
  };
}

/**
 * Produce completion items for a typed receiver — `$x.` where `$x` is of
 * type `normalizedType`. Dispatches on the type's shape:
 *   - `cs.<NS>.<Class>` → component-class members
 *   - bare `<ProjectClass>` → project class members (inherited included)
 *   - `EntitySelection<T>` / `Entity<T>` / `Collection` / etc. → builtin API
 */
function membersForType(graph: CallGraph, normalizedType: string): CompletionItem[] {
  // Component class.
  if (/^cs\.[\w_]+\.[\w_]+$/.test(normalizedType)) {
    const ownerLc = normalizedType.toLowerCase();
    const out: CompletionItem[] = [];
    for (const s of graph.allSymbols()) {
      if (s.ownerClass?.toLowerCase() !== ownerLc) continue;
      if (!CLASS_MEMBER_KINDS.has(s.kind)) continue;
      out.push(toItem(s));
      if (out.length >= MAX_MEMBERS) break;
    }
    return out;
  }
  // Project class — membersOfClass already walks inheritance.
  const projectClass = graph
    .byName(normalizedType.replace(/<.*>$/, ""))
    .find((s) => s.kind === SymbolKind.Class);
  if (projectClass) {
    return membersOfClass(graph, projectClass.name).map(toItem);
  }
  // Builtin type — enumerate BUILTIN_TYPE_API entries for the base.
  const parts = splitBuiltin(normalizedType);
  const base = parts?.base ?? normalizedType;
  const api = BUILTIN_TYPE_API[base];
  if (!api) return [];
  const out: CompletionItem[] = [];
  for (const [methodName, ret] of Object.entries(api)) {
    if (!methodName) continue;
    out.push({
      label: methodName,
      kind: CompletionItemKind.Method,
      detail: prettyBuiltinReturn(base, parts?.param, ret),
      data: { id: `Builtin:${base}.${methodName}` }
    });
  }
  return out;
}

function prettyBuiltinReturn(base: string, param: string | undefined, ret: string): string {
  if (ret === "") return base;
  if (ret === PARAM_ENTITY) return param ?? `Entity<${base}>`;
  if (ret === PARAM_SELECTION) return param ? `EntitySelection<${param}>` : "EntitySelection";
  return ret;
}

/** Walk inheritance chain on the graph; collect member symbols matching kinds. */
function membersOfClass(graph: CallGraph, className: string): SymbolRecord[] {
  const lower = className.toLowerCase();
  const out: SymbolRecord[] = [];
  const seenNames = new Set<string>();
  const visited = new Set<string>();
  let cur: string | undefined = className;
  while (cur && !visited.has(cur.toLowerCase())) {
    visited.add(cur.toLowerCase());
    for (const s of graph.allSymbols()) {
      if (!s.ownerClass) continue;
      if (s.ownerClass.toLowerCase() !== cur.toLowerCase()) continue;
      if (!CLASS_MEMBER_KINDS.has(s.kind)) continue;
      if (seenNames.has(s.name.toLowerCase())) continue;
      seenNames.add(s.name.toLowerCase());
      out.push(s);
    }
    const parent: string | undefined = graph.byName(cur).find((s) => s.kind === SymbolKind.Class)?.extendsClass;
    cur = parent;
  }
  // Suppress for first call: lower was unused if className === cur initially.
  void lower;
  return out;
}

/** Component classes under a given classStore namespace (e.g., 'Testing'). */
function componentClassesInNs(graph: CallGraph, namespace: string): SymbolRecord[] {
  const prefix = `Class:cs.${namespace}.`.toLowerCase();
  return graph.allSymbols().filter((s) => s.kind === SymbolKind.Class && s.id.toLowerCase().startsWith(prefix));
}

/**
 * Infer the class name for a 4D class file from its URI.
 * `.../Project/Sources/Classes/Foo.4dm` → `Foo`.
 */
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

export function registerCompletionHandler(
  state: ServerState,
  connection: Connection,
  documents: TextDocuments<TextDocument>
): void {
  connection.onCompletion((params: CompletionParams): CompletionList | CompletionItem[] => {
    const graph = state.graph;
    if (!graph) return [];
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];

    const linePrefix = doc.getText({
      start: { line: params.position.line, character: 0 },
      end: params.position
    });
    const ctx = parseContext(linePrefix);
    if (!ctx) return [];

    if (ctx.kind === "csns") {
      // cs.<ns>.<Class>. → component class members.
      const fq = `cs.${ctx.namespace}.${ctx.className}`;
      const items: CompletionItem[] = [];
      for (const s of graph.allSymbols()) {
        if (!s.ownerClass) continue;
        if (s.ownerClass.toLowerCase() !== fq.toLowerCase()) continue;
        if (!CLASS_MEMBER_KINDS.has(s.kind)) continue;
        items.push(toItem(s));
        if (items.length >= MAX_MEMBERS) break;
      }
      return items;
    }

    if (ctx.kind === "cs") {
      // Two possibilities:
      //   1. cs.<ProjectClass>.  → enumerate that class's members
      //   2. cs.<componentNs>.   → enumerate classes under that namespace
      const items: CompletionItem[] = [];
      const projectMatch = graph.byName(ctx.first).find((s) => s.kind === SymbolKind.Class && !s.ownerComponent);
      if (projectMatch) {
        for (const m of membersOfClass(graph, projectMatch.name)) {
          items.push(toItem(m));
          if (items.length >= MAX_MEMBERS) break;
        }
      }
      // Component namespace (case-sensitive in 4D for classStore names; tolerant here).
      for (const cls of componentClassesInNs(graph, ctx.first)) {
        items.push(toItem(cls));
        if (items.length >= MAX_MEMBERS) break;
      }
      return items;
    }

    if (ctx.kind === "this") {
      const className = classFromUri(params.textDocument.uri);
      if (!className) return [];
      return membersOfClass(graph, className).map(toItem);
    }

    if (ctx.kind === "var") {
      // Locate the enclosing function and infer `$var` types from its body.
      const source = doc.getText();
      const scope = findEnclosingFunction(source, params.position.line);
      const locals = inferLocals(source, scope.startLine, scope.endLine);
      const rawType = locals.get(ctx.variable);
      const normalized = normalizeLocalType(rawType);
      if (!normalized) return [];
      return membersForType(graph, normalized);
    }

    // Free completion.
    const prefix = ctx.prefix.toLowerCase();
    const out: CompletionItem[] = [];
    let scanned = 0;
    // Manual trigger (Ctrl+Space) tolerates a short prefix; auto-trigger
    // already enforces MIN_FREE_PREFIX in parseContext.
    void params.context?.triggerKind === CompletionTriggerKind.Invoked;
    for (const s of graph.allSymbols()) {
      scanned++;
      if (!FREE_KINDS.has(s.kind)) continue;
      if (!s.name.toLowerCase().startsWith(prefix)) continue;
      out.push(toItem(s));
      if (out.length >= MAX_FREE) break;
    }
    void scanned;
    return {
      isIncomplete: out.length >= MAX_FREE,
      items: out
    };
  });

  // Hook for late-detail enrichment — keep it light, just patch in the kind detail.
  connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
    void InsertTextFormat.PlainText;
    return item;
  });
}
