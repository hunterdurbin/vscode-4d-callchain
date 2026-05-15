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
        callHierarchyProvider: true
      }
    };
  });

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
    } catch (err) {
      connection.console.error(`[Server] Indexer failed: ${err}`);
    }
  });

  connection.onDidChangeWatchedFiles((params) => {
    if (!state.indexer) return;
    for (const change of params.changes) {
      if (change.type === FileChangeType.Deleted) {
        // Still trigger; the indexer will skip on missing files anyway.
      }
      const fsPath = URI.parse(change.uri).fsPath;
      void state.indexer.patchFile(fsPath);
    }
  });

  registerSymbolHandlers(state, connection);
  registerDefinitionHandler(state, connection, documents);
  registerReferencesHandler(state, connection, documents);
  registerCallHierarchyHandlers(state, connection, documents);
  registerCustomHandlers(state, connection);

  documents.listen(connection);
  connection.listen();
}

function looksLike4DProject(root: string): boolean {
  // Heuristic identical to the extension's activationEvents.
  return fs.existsSync(path.join(root, "Project", "Sources", "catalog.4DCatalog"))
      || fs.existsSync(path.join(root, "Project"));
}
