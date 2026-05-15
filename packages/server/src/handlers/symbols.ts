import {
  Connection,
  DocumentSymbolParams,
  WorkspaceSymbolParams,
  SymbolInformation,
  Location,
  Range
} from "vscode-languageserver/node";
import { fuzzyMatch, parseFilterQuery, SymbolKind, SymbolRecord } from "@4d/core";
import { ServerState } from "../state";
import { toLspKind } from "../symbolKind";

const MAX_WORKSPACE_RESULTS = 500;

function rangeFor(s: SymbolRecord): Range {
  const start = { line: s.location.line, character: s.location.column ?? 0 };
  const endLine = s.location.endLine ?? s.location.line;
  return { start, end: { line: endLine, character: 0 } };
}

function toSymbolInfo(s: SymbolRecord): SymbolInformation {
  return {
    name: s.name,
    kind: toLspKind(s.kind),
    location: Location.create(s.location.uri, rangeFor(s)),
    containerName: s.ownerClass ?? s.ownerComponent ?? s.ownerPlugin
  };
}

export function registerSymbolHandlers(state: ServerState, connection: Connection): void {
  connection.onDocumentSymbol((params: DocumentSymbolParams) => {
    const graph = state.graph;
    if (!graph) return [];
    const target = params.textDocument.uri;
    return graph.allSymbols()
      .filter((s) => s.location.uri === target)
      .filter((s) => s.kind !== SymbolKind.Builtin && s.kind !== SymbolKind.Unresolved)
      .map(toSymbolInfo);
  });

  connection.onWorkspaceSymbol((params: WorkspaceSymbolParams) => {
    const graph = state.graph;
    if (!graph) return [];
    const parsed = parseFilterQuery(params.query);
    const fuzzy = parsed.fuzzy;
    const out: SymbolInformation[] = [];
    for (const s of graph.allSymbols()) {
      if (s.kind === SymbolKind.Builtin || s.kind === SymbolKind.Unresolved) continue;
      if (fuzzy && !fuzzyMatch(fuzzy, s.name)) continue;
      if (parsed.excludes.some((e) => fuzzyMatch(e, s.name))) continue;
      out.push(toSymbolInfo(s));
      if (out.length >= MAX_WORKSPACE_RESULTS) break;
    }
    return out;
  });
}
