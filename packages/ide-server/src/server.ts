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
import { registerHoverHandler } from "./handlers/hover";

interface InitOptions {
  exclusions?: string[];
  builtinConstantsPaths?: string[];
}

/**
 * IDE-feature LSP server. Runs side-by-side with @4d/language-server (which
 * handles symbols / definition / references / callHierarchy). Each server
 * indexes independently — they share the on-disk cache at
 * `<projectRoot>/.vscode/callchain-index.json`, so warm starts skip the
 * reparse and either server can be the first to populate it.
 */
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
        hoverProvider: true
      }
    };
  });

  connection.onInitialized(async () => {
    if (!state.projectRoot) {
      connection.console.warn("[IDE] No workspace folder — indexer not started.");
      return;
    }
    if (!looksLike4DProject(state.projectRoot)) {
      connection.console.warn(`[IDE] ${state.projectRoot} does not look like a 4D project — idle.`);
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
      connection.console.error(`[IDE] Indexer failed: ${err}`);
    }
  });

  connection.onDidChangeWatchedFiles((params) => {
    if (!state.indexer) return;
    for (const change of params.changes) {
      if (change.type === FileChangeType.Deleted) {
        // patchFile handles missing files gracefully.
      }
      const fsPath = URI.parse(change.uri).fsPath;
      void state.indexer.patchFile(fsPath);
    }
  });

  registerHoverHandler(state, connection, documents);

  documents.listen(connection);
  connection.listen();
}

function looksLike4DProject(root: string): boolean {
  return fs.existsSync(path.join(root, "Project", "Sources", "catalog.4DCatalog"))
      || fs.existsSync(path.join(root, "Project"));
}
