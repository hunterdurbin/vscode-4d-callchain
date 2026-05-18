import * as fs from "fs";
import * as path from "path";
import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  InitializeParams,
  InitializeResult,
  FileChangeType
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { Indexer } from "@4d/core";

import { ServerState } from "./state";
import { registerSymbolHandlers } from "./handlers/symbols";
import { registerDefinitionHandler } from "./handlers/definition";
import { registerReferencesHandler } from "./handlers/references";
import { registerCallHierarchyHandlers } from "./handlers/callHierarchy";
import { registerCustomHandlers } from "./handlers/custom";
import { registerFoldingHandler } from "./handlers/folding";
import { registerSelectionRangeHandler } from "./handlers/selectionRange";
import { registerDocumentHighlightHandler } from "./handlers/documentHighlight";
import { registerDiagnostics } from "./handlers/diagnostics";
import { registerSemanticTokensHandler, SEMANTIC_TOKENS_LEGEND } from "./handlers/semanticTokens";

interface InitOptions {
  exclusions?: string[];
  builtinConstantsPaths?: string[];
}

export function startServer(): void {
  const connection = createConnection(ProposedFeatures.all);
  const documents = new TextDocuments(TextDocument);
  const state = new ServerState(connection);
  let initOptions: InitOptions = {};

  connection.onInitialize((params: InitializeParams): InitializeResult => {
    const folder = params.workspaceFolders?.[0];
    const rootUriStr = folder?.uri ?? params.rootUri ?? undefined;
    if (rootUriStr) {
      state.projectRoot = URI.parse(rootUriStr).fsPath;
    } else if (params.rootPath) {
      state.projectRoot = params.rootPath;
    }
    initOptions = (params.initializationOptions ?? {}) as InitOptions;
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        callHierarchyProvider: true,
        foldingRangeProvider: true,
        selectionRangeProvider: true,
        documentHighlightProvider: true,
        semanticTokensProvider: {
          legend: SEMANTIC_TOKENS_LEGEND,
          full: { delta: false },
          range: true
        }
      }
    };
  });

  const diagnostics = registerDiagnostics(state);

  connection.onInitialized(async () => {
    if (!state.projectRoot) {
      connection.console.warn("[Server] No workspace folder — indexer not started.");
      return;
    }
    if (!looksLike4DProject(state.projectRoot)) {
      connection.console.warn(`[Server] ${state.projectRoot} does not look like a 4D project — indexer idle.`);
      return;
    }

    state.indexer = new Indexer({
      projectRoot: state.projectRoot,
      exclusions: initOptions.exclusions ?? ["DerivedData", "Libraries", ".git", "node_modules"],
      builtinConstantsPaths: initOptions.builtinConstantsPaths ?? [],
      logger: state.makeLogger()
    });

    try {
      await state.indexer.load();
      diagnostics.publishForAllSymbols();
      // The semantic-tokens handler reads PluginCommand symbols out of the
      // graph to feed plugin-command names into the lexer. If a `.4dm` file
      // was open before the index finished, VS Code already cached an empty
      // (no-plugin) token set for it — without a refresh nudge those stale
      // tokens stay on screen forever.
      void connection.languages.semanticTokens.refresh();
    } catch (err) {
      connection.console.error(`[Server] Indexer failed: ${err}`);
    }
  });

  connection.onDidChangeWatchedFiles(async (params) => {
    if (!state.indexer) return;
    for (const change of params.changes) {
      const fsPath = URI.parse(change.uri).fsPath;
      if (change.type === FileChangeType.Deleted) {
        diagnostics.clearForFile(change.uri);
      }
      await state.indexer.patchFile(fsPath);
      diagnostics.publishForFile(change.uri);
    }
  });

  documents.onDidSave((e) => {
    diagnostics.publishForFile(e.document.uri);
  });
  documents.onDidOpen((e) => {
    diagnostics.publishForFile(e.document.uri);
  });

  registerSymbolHandlers(state, connection);
  registerDefinitionHandler(state, connection, documents);
  registerReferencesHandler(state, connection, documents);
  registerCallHierarchyHandlers(state, connection, documents);
  registerCustomHandlers(state, connection);
  registerFoldingHandler(connection, documents);
  registerSelectionRangeHandler(connection, documents);
  registerDocumentHighlightHandler(state, connection, documents);
  registerSemanticTokensHandler(state, connection, documents);

  documents.listen(connection);
  connection.listen();
}

function looksLike4DProject(root: string): boolean {
  // Heuristic identical to the extension's activationEvents.
  return fs.existsSync(path.join(root, "Project", "Sources", "catalog.4DCatalog"))
      || fs.existsSync(path.join(root, "Project"));
}
