import {
  Connection,
  DocumentHighlight,
  DocumentHighlightKind,
  DocumentHighlightParams,
  Range,
  TextDocuments
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { ServerState, wordAt, lookupByName } from "../state";
import { rangeForSymbol } from "../range";

/**
 * Highlight all occurrences of the identifier under the cursor within the
 * current file. Read kind for call sites, Write kind for the declaration
 * (if it lives in this file).
 */
export function registerDocumentHighlightHandler(
  state: ServerState,
  connection: Connection,
  documents: TextDocuments<TextDocument>
): void {
  connection.onDocumentHighlight((params: DocumentHighlightParams): DocumentHighlight[] => {
    const graph = state.graph;
    if (!graph) return [];
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];

    const uri = params.textDocument.uri;
    const lineText = doc.getText({
      start: { line: params.position.line, character: 0 },
      end: { line: params.position.line + 1, character: 0 }
    });
    const word = wordAt(lineText, params.position.character);
    if (!word) return [];

    const out: DocumentHighlight[] = [];
    const seen = new Set<string>();
    const emit = (range: Range, kind: DocumentHighlightKind) => {
      const key = `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ range, kind });
    };

    for (const target of lookupByName(graph, word)) {
      // Call-site occurrences within the current file.
      for (const edge of graph.callers(target.id)) {
        const from = graph.symbol(edge.fromId);
        if (!from?.location.uri || from.location.uri !== uri) continue;
        const startChar = edge.column ?? 0;
        const endChar = edge.endColumn ?? Math.max(startChar + word.length, startChar);
        emit({
          start: { line: edge.line, character: startChar },
          end: { line: edge.line, character: endChar }
        }, DocumentHighlightKind.Read);
      }
      // Declaration occurrence (Write kind) when it lives in this file.
      if (target.location.uri === uri) {
        emit(rangeForSymbol(target), DocumentHighlightKind.Write);
      }
    }
    return out;
  });
}
