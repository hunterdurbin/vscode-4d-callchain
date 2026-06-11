import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { initTreeSitterParser } from "@4d/core";
import { LanguageClient } from "vscode-languageclient/node";
import { TestStatusDecorator } from "./decorations/testStatusDecorator";
import { registerMcpSetup } from "./mcp/setupMcp";
import * as config from "./config";
import { resolveProjectRoot } from "./activation/projectRoot";
import { createIndexer, registerIndexWatchers } from "./indexing/indexerService";
import { registerViews } from "./views/registerViews";
import { CoverageService } from "./coverage/coverageService";
import { registerLenses } from "./lenses/registerLenses";
import { registerNavigationCommands } from "./commands/navigationCommands";
import { registerFilterCommands } from "./commands/filterCommands";
import { registerTestIntegration } from "./testing/testIntegration";
import { startLanguageServer } from "./lsp/client";

let lspClient: LanguageClient | undefined;
let indexerRef: ReturnType<typeof createIndexer> | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("4D Call Chain");
  const testOutput = vscode.window.createOutputChannel("4D Call Chain - Tests");
  context.subscriptions.push(output, testOutput);

  const projectRoot = resolveProjectRoot();
  if (!projectRoot) {
    output.appendLine("[Activate] No 4D project root resolved; extension idle.");
    return;
  }
  output.appendLine(`[Activate] Project root: ${projectRoot}`);

  await initParser(output);

  const exclusions = config.indexExclusions();
  const constantsPaths = config.builtinConstantsPaths();
  // Feature gates for the lean Call-Chain-only build. The LSP server and the
  // test-integration subsystem are not required by Call Chain — default off,
  // flip the matching callchain.* setting to re-enable.
  const testEnabled = config.testsEnabled();
  const serverEnabled = config.serverEnabled();

  const indexer = createIndexer({ projectRoot, exclusions, builtinConstantsPaths: constantsPaths, output, serverEnabled });
  indexerRef = indexer;

  const views = registerViews(context);

  // Coverage hints stand alone: when on, coverage is computed even with test
  // integration off. The patterns decide what counts as a test; the callers
  // test filter uses the same test-detection regexes as coverage.
  const coverage = new CoverageService(() => indexer.getGraph(), testEnabled, output);
  context.subscriptions.push(coverage);
  views.callers.setTestPatterns(coverage.getPatterns());

  // The pass/fail gutter decorator exists only when test integration is on —
  // with it off there are no results to render, and its document-change
  // listeners shouldn't be ticking on every keystroke.
  const decorator = testEnabled ? new TestStatusDecorator() : undefined;
  if (decorator) context.subscriptions.push(decorator);

  const lensProvider = registerLenses(context, indexer, coverage, () => decorator);

  // Coverage-related config changes recompute the report and re-render its
  // consumers (gutter hints via the service, lenses + callers filter here).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("callchain.coverage")) {
        coverage.refreshFromConfig();
        views.callers.setTestPatterns(coverage.getPatterns());
        lensProvider.refresh();
      }
    })
  );

  // Wire indexer → views, coverage, lenses. Coverage is only INVALIDATED
  // here — the full-graph DFS it implies runs on a trailing timer after the
  // save burst settles, never synchronously on the indexer-update path (which
  // shares the extension-host thread with every other extension's save
  // participants). Lenses re-render now with the stale report and again via
  // onDidCompute when the fresh one lands.
  indexer.onDidUpdate((graph) => {
    views.callers.setGraph(graph);
    views.callees.setGraph(graph);
    views.search.setGraph(graph);
    views.tracker.setGraph(graph);
    coverage.invalidate();
    lensProvider.refresh();
  });
  context.subscriptions.push(coverage.onDidCompute(() => lensProvider.refresh()));

  registerIndexWatchers(context, projectRoot, indexer);
  registerNavigationCommands(context, indexer, views, output);
  registerFilterCommands(context, views);
  context.subscriptions.push(registerMcpSetup(context, resolveProjectRoot));

  if (testEnabled && decorator) {
    decorator.onDidChange(() => lensProvider.refresh());
    registerTestIntegration(context, projectRoot, indexer, decorator, coverage, output, testOutput);
  }

  if (config.autoIndexOnStartup()) {
    indexer.load().catch((err) => output.appendLine(`[Indexer] failed: ${err}`));
  }

  // Spawn the call-chain LSP server. One process serving the standard LSP
  // methods — definition / references / workspace + document symbols / call
  // hierarchy / semantic tokens / diagnostics — plus hover, completion, and
  // signature help. VSCode's native UIs (F12, Shift+F12, Peek Call Hierarchy)
  // pick these up automatically once the document selector matches. Gated:
  // off by default, and a separate process that re-indexes independently.
  if (serverEnabled) {
    try {
      lspClient = startLanguageServer(output, exclusions, constantsPaths);
      context.subscriptions.push({ dispose: () => { void lspClient?.stop(); } });
    } catch (err) {
      output.appendLine(`[LSP] Failed to start language-server: ${err}`);
    }
  } else {
    output.appendLine("[Activate] language-server disabled (callchain.server.enabled = false).");
  }
}

export async function deactivate(): Promise<void> {
  // Land any pending (debounced) cache write before the host kills us.
  await indexerRef?.flushPersist();
  indexerRef = undefined;
  await lspClient?.stop();
  lspClient = undefined;
}

/**
 * Bring up the tree-sitter parser before the indexer constructs so
 * parseFile() takes the new path from the first scan. Failures fall
 * back silently to the regex parser via fileParser's dispatch.
 *
 * In the packaged (esbuild-bundled) extension, the two wasm assets are
 * copied next to dist/extension.js — point the loader at them explicitly,
 * since the package-relative resolution of web-tree-sitter / @4d/parser-4d
 * doesn't survive bundling. Running from source they're absent, so we fall
 * through to the default resolution.
 */
async function initParser(output: vscode.OutputChannel): Promise<void> {
  try {
    const runtimeWasm = path.join(__dirname, "tree-sitter.wasm");
    const languageWasm = path.join(__dirname, "tree-sitter-fourd.wasm");
    const initOpts: { runtimeWasmPath?: string; languageWasmPath?: string } = {};
    if (fs.existsSync(runtimeWasm)) initOpts.runtimeWasmPath = runtimeWasm;
    if (fs.existsSync(languageWasm)) initOpts.languageWasmPath = languageWasm;
    await initTreeSitterParser(initOpts);
  } catch (e) {
    output.appendLine(`[Activate] Tree-sitter init failed; using regex parser: ${(e as Error).message}`);
  }
}
