import {
  Connection,
  ReferenceParams,
  Location,
  Range,
  TextDocuments
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { ServerState, wordAt, lookupByName } from "../state";

export function registerReferencesHandler(
  state: ServerState,
  connection: Connection,
  documents: TextDocuments<TextDocument>
): void {
  connection.onReferences((params: ReferenceParams): Location[] => {
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

    const out: Location[] = [];
    const seen = new Set<string>();
    for (const target of lookupByName(graph, word)) {
      // Edges where target is the callee → list each call site.
      for (const edge of graph.callers(target.id)) {
        const from = graph.symbol(edge.fromId);
        if (!from?.location.uri) continue;
        const key = `${from.location.uri}:${edge.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(Location.create(
          from.location.uri,
          Range.create({ line: edge.line, character: 0 }, { line: edge.line, character: 0 })
        ));
      }
      // includeDeclaration: include the target's own definition.
      if (params.context.includeDeclaration) {
        out.push(Location.create(
          target.location.uri,
          Range.create({ line: target.location.line, character: 0 }, { line: target.location.line, character: 0 })
        ));
      }
    }
    return out;
  });
}
