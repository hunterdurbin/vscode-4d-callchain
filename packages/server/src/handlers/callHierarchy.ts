import {
  Connection,
  CallHierarchyPrepareParams,
  CallHierarchyIncomingCallsParams,
  CallHierarchyOutgoingCallsParams,
  CallHierarchyItem,
  CallHierarchyIncomingCall,
  CallHierarchyOutgoingCall,
  Range,
  TextDocuments
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { SymbolRecord } from "@4d/core";
import { ServerState, wordAt, lookupByName } from "../state";
import { toLspKind } from "../symbolKind";

function rangeFor(s: SymbolRecord): Range {
  const start = { line: s.location.line, character: s.location.column ?? 0 };
  const endLine = s.location.endLine ?? s.location.line;
  return { start, end: { line: endLine, character: 0 } };
}

function itemFor(s: SymbolRecord): CallHierarchyItem {
  return {
    name: s.name,
    kind: toLspKind(s.kind),
    detail: s.ownerClass ?? s.ownerComponent ?? s.ownerPlugin ?? s.kind,
    uri: s.location.uri,
    range: rangeFor(s),
    selectionRange: rangeFor(s),
    data: { id: s.id }
  };
}

export function registerCallHierarchyHandlers(
  state: ServerState,
  connection: Connection,
  documents: TextDocuments<TextDocument>
): void {
  connection.languages.callHierarchy.onPrepare((params: CallHierarchyPrepareParams): CallHierarchyItem[] => {
    const graph = state.graph;
    if (!graph) return [];
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const line = doc.getText({
      start: { line: params.position.line, character: 0 },
      end: { line: params.position.line + 1, character: 0 }
    });
    const word = wordAt(line, params.position.character);
    if (!word) return [];
    return lookupByName(graph, word).map(itemFor);
  });

  connection.languages.callHierarchy.onIncomingCalls((params: CallHierarchyIncomingCallsParams): CallHierarchyIncomingCall[] => {
    const graph = state.graph;
    if (!graph) return [];
    const id = (params.item.data as { id?: string } | undefined)?.id;
    if (!id) return [];
    const grouped = new Map<string, { from: SymbolRecord; ranges: Range[] }>();
    for (const edge of graph.callers(id)) {
      const from = graph.symbol(edge.fromId);
      if (!from) continue;
      const key = from.id;
      const r = Range.create({ line: edge.line, character: 0 }, { line: edge.line, character: 0 });
      const existing = grouped.get(key);
      if (existing) existing.ranges.push(r);
      else grouped.set(key, { from, ranges: [r] });
    }
    return Array.from(grouped.values()).map(({ from, ranges }) => ({
      from: itemFor(from),
      fromRanges: ranges
    }));
  });

  connection.languages.callHierarchy.onOutgoingCalls((params: CallHierarchyOutgoingCallsParams): CallHierarchyOutgoingCall[] => {
    const graph = state.graph;
    if (!graph) return [];
    const id = (params.item.data as { id?: string } | undefined)?.id;
    if (!id) return [];
    const grouped = new Map<string, { to: SymbolRecord; ranges: Range[] }>();
    for (const edge of graph.callees(id)) {
      const to = graph.symbol(edge.toId);
      if (!to) continue;
      const key = to.id;
      // fromRanges are positions in the *caller's* file, marking each call site.
      const r = Range.create({ line: edge.line, character: 0 }, { line: edge.line, character: 0 });
      const existing = grouped.get(key);
      if (existing) existing.ranges.push(r);
      else grouped.set(key, { to, ranges: [r] });
    }
    return Array.from(grouped.values()).map(({ to, ranges }) => ({
      to: itemFor(to),
      fromRanges: ranges
    }));
  });
}
