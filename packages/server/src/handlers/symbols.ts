import {
  Connection,
  DocumentSymbolParams,
  WorkspaceSymbolParams,
  SymbolInformation,
  Location
} from "vscode-languageserver/node";
import { fuzzyMatch, parseFilterQuery, SymbolKind, SymbolRecord } from "@4d/core";
import { ServerState } from "../state";
import { toLspKind } from "../symbolKind";
import { rangeForSymbol } from "../range";

const MAX_WORKSPACE_RESULTS = 500;

function toSymbolInfo(s: SymbolRecord): SymbolInformation {
  return {
    name: s.name,
    kind: toLspKind(s.kind),
    location: Location.create(s.location.uri, rangeForSymbol(s)),
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
