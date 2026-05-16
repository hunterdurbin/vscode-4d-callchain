import {
  Connection,
  Hover,
  HoverParams,
  MarkupKind,
  Range,
  TextDocuments
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { SymbolKind, SymbolRecord } from "@4d/core";
import { URI } from "vscode-uri";
import * as path from "path";
import { ServerState, wordAt, lookupByName } from "../state";

const MAX_CALLERS_SHOWN = 5;

function rangeForWord(line: string, character: number): Range | undefined {
  if (character < 0 || character > line.length) return undefined;
  const isWord = (c: string) => /[A-Za-z0-9_]/.test(c);
  let start = character;
  let end = character;
  while (start > 0 && isWord(line[start - 1])) start--;
  while (end < line.length && isWord(line[end])) end++;
  if (start === end) return undefined;
  return Range.create(0, start, 0, end);
}

function relativePath(uri: string, projectRoot: string | undefined): string {
  try {
    const fsPath = URI.parse(uri).fsPath;
    if (projectRoot && fsPath.startsWith(projectRoot)) {
      return path.relative(projectRoot, fsPath);
    }
    return fsPath;
  } catch {
    return uri;
  }
}

function formatSymbol(s: SymbolRecord, state: ServerState): string {
  const lines: string[] = [];
  // Heading: `<Name>` _(SymbolKind)_
  lines.push(`**${s.name}** _(${s.kind})_`);

  const meta: string[] = [];
  if (s.ownerClass) meta.push(`Class: \`${s.ownerClass}\``);
  if (s.ownerPlugin) meta.push(`Plugin: \`${s.ownerPlugin}\``);
  if (s.ownerComponent) meta.push(`Component: \`${s.ownerComponent}\``);
  if (s.ownerTable) meta.push(`Table: \`${s.ownerTable}\``);
  if (s.classFlavor) meta.push(`Flavor: ${s.classFlavor}`);
  if (s.extendsClass) meta.push(`Extends: \`${s.extendsClass}\``);
  if (s.accessor && s.accessor !== "function") meta.push(`Accessor: ${s.accessor}`);
  if (s.scope && s.scope !== "public") meta.push(`Scope: ${s.scope}`);
  if (s.returnType) meta.push(`Returns: \`${s.returnType}\``);
  if (s.constantValue !== undefined) {
    const typeStr = s.constantType ? ` (${s.constantType})` : "";
    meta.push(`Value: \`${s.constantValue}\`${typeStr}`);
  }
  if (s.constantTheme) meta.push(`Theme: ${s.constantTheme}`);
  if (s.variableType) meta.push(`Type: \`${s.variableType}\``);
  if (meta.length > 0) lines.push("", meta.join("  \n"));

  // Location
  if (s.location.uri) {
    const rel = relativePath(s.location.uri, state.projectRoot);
    const line = (s.location.line ?? 0) + 1;
    lines.push("", `📄 \`${rel}:${line}\``);
  }

  // Caller summary
  if (state.graph) {
    const callers = state.graph.callers(s.id);
    if (callers.length > 0) {
      const unique = new Set(callers.map((e) => e.fromId));
      lines.push("", `▲ Callers: **${unique.size}** unique, **${callers.length}** call site${callers.length === 1 ? "" : "s"}`);
      const top: SymbolRecord[] = [];
      const seen = new Set<string>();
      for (const e of callers) {
        if (seen.has(e.fromId)) continue;
        seen.add(e.fromId);
        const from = state.graph.symbol(e.fromId);
        if (from) top.push(from);
        if (top.length >= MAX_CALLERS_SHOWN) break;
      }
      if (top.length > 0) {
        const list = top.map((c) => `- \`${c.name}\`${c.ownerClass ? ` · ${c.ownerClass}` : ""}`);
        if (unique.size > MAX_CALLERS_SHOWN) {
          list.push(`- _…and ${unique.size - MAX_CALLERS_SHOWN} more_`);
        }
        lines.push("", list.join("\n"));
      }
    }
    const callees = state.graph.callees(s.id);
    if (callees.length > 0) {
      const unique = new Set(callees.map((e) => e.toId));
      lines.push("", `▼ Callees: **${unique.size}** unique, **${callees.length}** call site${callees.length === 1 ? "" : "s"}`);
    }
  }

  return lines.join("\n");
}

export function registerHoverHandler(
  state: ServerState,
  connection: Connection,
  documents: TextDocuments<TextDocument>
): void {
  connection.onHover((params: HoverParams): Hover | null => {
    const graph = state.graph;
    if (!graph) return null;
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const line = doc.getText({
      start: { line: params.position.line, character: 0 },
      end: { line: params.position.line + 1, character: 0 }
    }).replace(/\r?\n$/, "");
    const word = wordAt(line, params.position.character);
    if (!word) return null;
    const matches = lookupByName(graph, word);
    if (matches.length === 0) return null;
    // If multiple symbols share the name, show them as separate sections so
    // the user can disambiguate.
    const limited = matches.slice(0, 4);
    const sections = limited.map((s) => formatSymbol(s, state));
    if (matches.length > limited.length) {
      sections.push(`_…and ${matches.length - limited.length} more matches_`);
    }
    const range = rangeForWord(line, params.position.character);
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: sections.join("\n\n---\n\n")
      },
      range: range
        ? Range.create(params.position.line, range.start.character, params.position.line, range.end.character)
        : undefined
    };
  });
}
