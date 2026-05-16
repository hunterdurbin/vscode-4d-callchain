import {
  Connection,
  DefinitionParams,
  Location,
  TextDocuments
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { ServerState, wordAt, lookupByName } from "../state";
import { rangeForSymbol } from "../range";

export function registerDefinitionHandler(
  state: ServerState,
  connection: Connection,
  documents: TextDocuments<TextDocument>
): void {
  connection.onDefinition((params: DefinitionParams): Location[] => {
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
    const matches = lookupByName(graph, word);
    return matches.map((s) => Location.create(s.location.uri, rangeForSymbol(s)));
  });
}
