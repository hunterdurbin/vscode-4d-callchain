import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Indexer, SymbolKind, initTreeSitterParser } from "@4d/core";
import type { SymbolRecord } from "@4d/core";
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from "vscode-languageclient/node";
import { CallTreeProvider } from "./views/callTreeProvider";
import { SymbolSearchProvider } from "./views/symbolSearchProvider";
import { CursorTracker } from "./views/cursorTracker";
import { GraphPanel } from "./views/graphView/graphPanel";
import { TestStatusDecorator } from "./decorations/testStatusDecorator";
import { delegateToScottHarris, isScottHarrisInstalled, runTests } from "./testing/testRunner";
import { TestResultsWatcher } from "./testing/resultsWatcher";
import { CoverageReport, computeCoverage } from "./testing/coverage";
import { CallChainLensProvider } from "./codelens/callChainLens";
import { DirtyLineTracker } from "./codelens/dirtyLineTracker";
import { debounce } from "./util/debounce";

let ideClient: LanguageClient | undefined;
let lspClient: LanguageClient | undefined;

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

  // Bring up the tree-sitter parser before the indexer constructs so
  // parseFile() takes the new path from the first scan. Failures fall
  // back silently to the regex parser via fileParser's dispatch.
  //
  // In the packaged (esbuild-bundled) extension, the two wasm assets are
  // copied next to dist/extension.js — point the loader at them explicitly,
  // since the package-relative resolution of web-tree-sitter / @4d/parser-4d
  // doesn't survive bundling. Running from source they're absent, so we fall
  // through to the default resolution.
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

  const cfg = vscode.workspace.getConfiguration("callchain");
  const exclusions = cfg.get<string[]>("indexExclusions", []);
  const builtinConstantsPaths = cfg.get<string[]>("builtinConstantsPaths", []);
  // Feature gates for the lean Call-Chain-only build. The two LSP servers and
  // the test-integration subsystem each cost a full project re-index (servers
  // run in their own process and scan independently) and are not required by
  // Call Chain — default off, flip the matching callchain.* setting to re-enable.
  const testEnabled = cfg.get<boolean>("testIntegration.enabled", false);
  const indexer = new Indexer({
    projectRoot,
    exclusions,
    builtinConstantsPaths,
    // Coalesce post-patch cache writes so a burst of saves only writes the
    // cache once, and so the JSON.stringify of a multi-MB index doesn't
    // block the extension host (= VSCode UI thread) on every save.
    persistDebounceMs: 250,
    logger: {
      info: (m) => output.appendLine(m),
      warn: (m) => output.appendLine(m),
      error: (m) => output.appendLine(m)
    }
  });

  const callers = new CallTreeProvider("callers");
  const callees = new CallTreeProvider("callees");
  const search  = new SymbolSearchProvider();
  const tracker = new CursorTracker();
  const decorator = new TestStatusDecorator();
  let coverage: CoverageReport | undefined;

  const callersView = vscode.window.createTreeView("callchain.callers", { treeDataProvider: callers });
  const calleesView = vscode.window.createTreeView("callchain.callees", { treeDataProvider: callees });
  const searchView  = vscode.window.createTreeView("callchain.search",  { treeDataProvider: search });
  context.subscriptions.push(callersView, calleesView, searchView);

  // Title badge: count + lock + active-filter summary.
  const buildBadge = (n: number, locked: boolean, filter: string, matches: number): string | undefined => {
    const parts: string[] = [];
    if (locked) parts.push("🔒");
    if (filter) parts.push(`🔍 "${filter}"·${matches}`);
    if (n > 0 && !filter) parts.push(`${n}`);
    return parts.length > 0 ? parts.join(" ") : undefined;
  };
  const refreshCallersBadge = () => {
    callersView.description = buildBadge(callers.directCount(), callers.isLocked, callers.filter, callers.filterMatches);
  };
  const refreshCalleesBadge = () => {
    calleesView.description = buildBadge(callees.directCount(), callees.isLocked, callees.filter, callees.filterMatches);
  };
  const refreshSymbolsBadge = () => {
    const bits: string[] = [];
    if (search.isFlat) bits.push("flat");
    if (search.currentSort === "callersDesc") bits.push("▲↓");
    if (search.currentSort === "callersAsc") bits.push("▲↑");
    if (search.currentCallerFilter === "withCallers") bits.push("▲≥1");
    if (search.currentCallerFilter === "noCallers") bits.push("▲=0");
    if (search.filter) bits.push(`🔍 "${search.filter}"`);
    searchView.description = bits.length ? bits.join(" ") : undefined;
  };
  context.subscriptions.push(
    callers.onDidChangeRoot(refreshCallersBadge),
    callees.onDidChangeRoot(refreshCalleesBadge),
    callers.onDidChangeFilter((q) => {
      vscode.commands.executeCommand("setContext", "callchain.callersFiltered", q.length > 0);
      refreshCallersBadge();
    }),
    callees.onDidChangeFilter((q) => {
      vscode.commands.executeCommand("setContext", "callchain.calleesFiltered", q.length > 0);
      refreshCalleesBadge();
    }),
    search.onDidChangeFilter((q) => {
      vscode.commands.executeCommand("setContext", "callchain.symbolsFiltered", q.length > 0);
      refreshSymbolsBadge();
    }),
    search.onDidChangeSort(() => refreshSymbolsBadge()),
    search.onDidChangeCallerFilter(() => refreshSymbolsBadge()),
    search.onDidChangeFlatten(() => refreshSymbolsBadge())
  );

  // Initialize context keys to false so the menus pick the right icon.
  vscode.commands.executeCommand("setContext", "callchain.callersLocked", false);
  vscode.commands.executeCommand("setContext", "callchain.calleesLocked", false);
  vscode.commands.executeCommand("setContext", "callchain.callersFiltered", false);
  vscode.commands.executeCommand("setContext", "callchain.calleesFiltered", false);
  vscode.commands.executeCommand("setContext", "callchain.symbolsFiltered", false);

  // React to config changes that affect tree rendering.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("callchain.showCallSiteSnippets")) {
        callers.refresh();
        callees.refresh();
      }
    })
  );

  // Keep lenses glued to their functions while a file is dirty: the index only
  // re-parses on save, so between edits and save we shift each lens by the net
  // newlines added/removed above it. Coalesce the re-render across keystrokes.
  const dirtyLines = new DirtyLineTracker(
    () => indexer.getGraph(),
    debounce(() => lensProvider.refresh(), 80)
  );
  context.subscriptions.push(dirtyLines);

  const lensProvider = new CallChainLensProvider(
    () => indexer.getGraph(),
    () => decorator,
    () => coverage,
    (uri, savedLine) => dirtyLines.displayLine(uri, savedLine)
  );
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ pattern: "**/*.{4dm,4DForm}" }, lensProvider)
  );

  // Wire indexer → views
  indexer.onDidUpdate((graph) => {
    callers.setGraph(graph);
    callees.setGraph(graph);
    search.setGraph(graph);
    tracker.setGraph(graph);
    // Coverage drives only the "N tests cover this" lens; skip the graph walk
    // entirely when test integration is off. Leaving `coverage` undefined makes
    // the lens fall back to just the caller/callee/graph annotations.
    if (testEnabled) coverage = computeCoverage(graph);
    lensProvider.refresh();
  });
  tracker.onDidChange((s) => {
    callers.setRoot(s?.id);
    callees.setRoot(s?.id);
  });

  // Test-results watcher: persistent JSON path + ScottHarris's transient files.
  // Gated — when test integration is off, no watcher, no decorations, and the
  // Run/coverage lenses never light up.
  if (testEnabled) {
    const resultsWatcher = new TestResultsWatcher(projectRoot, decorator, output);
    resultsWatcher.start();
    decorator.onDidChange(() => lensProvider.refresh());
    context.subscriptions.push(resultsWatcher);

    if (isScottHarrisInstalled()) {
      output.appendLine("[Activate] ScottHarris.4d-testing-extension detected — ▶ Run will delegate to its Test Explorer.");
    }
  }

  // File-system watchers — `.4dm` flows through the surgical patch path;
  // catalog / constants / components events trigger a full rebuild via the
  // indexer's classifier. Separate watchers per category keep the LSP
  // synchronize handler symmetric and let each category be tuned later
  // (e.g. component archive debounce) without affecting the others.
  const codeWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(projectRoot, "Project/Sources/**/*.4dm")
  );
  codeWatcher.onDidChange((uri) => indexer.patchFile(uri.fsPath));
  codeWatcher.onDidCreate((uri) => indexer.patchFile(uri.fsPath));
  codeWatcher.onDidDelete((uri) => indexer.patchFile(uri.fsPath));
  context.subscriptions.push(codeWatcher);

  const catalogWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(projectRoot, "Project/Sources/catalog.4DCatalog")
  );
  catalogWatcher.onDidChange((uri) => indexer.patchFile(uri.fsPath));
  catalogWatcher.onDidCreate((uri) => indexer.patchFile(uri.fsPath));
  catalogWatcher.onDidDelete((uri) => indexer.patchFile(uri.fsPath));
  context.subscriptions.push(catalogWatcher);

  const constantsWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(projectRoot, "Resources/Constants_*.xlf")
  );
  constantsWatcher.onDidChange((uri) => indexer.patchFile(uri.fsPath));
  constantsWatcher.onDidCreate((uri) => indexer.patchFile(uri.fsPath));
  constantsWatcher.onDidDelete((uri) => indexer.patchFile(uri.fsPath));
  context.subscriptions.push(constantsWatcher);

  const componentsWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(projectRoot, "Components/**/*.{4DZ,4dz}")
  );
  componentsWatcher.onDidChange((uri) => indexer.patchFile(uri.fsPath));
  componentsWatcher.onDidCreate((uri) => indexer.patchFile(uri.fsPath));
  componentsWatcher.onDidDelete((uri) => indexer.patchFile(uri.fsPath));
  context.subscriptions.push(componentsWatcher);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("callchain.reindex", async () => {
      output.show(true);
      await indexer.rebuild();
    }),
    vscode.commands.registerCommand("callchain.revealAtCursor", () => {
      // Tracker already updates the trees; force-focus the panel.
      vscode.commands.executeCommand("workbench.view.extension.callchain");
    }),
    vscode.commands.registerCommand("callchain.pinAndReveal", async (symbolId: string, which: "callers" | "callees") => {
      const graph = indexer.getGraph();
      if (!graph) return;
      const sym = graph.symbol(symbolId);
      if (!sym) return;
      // Explicit pin bypasses lock so "▲ N callers" / "▼ N callees" lenses always work.
      callers.pinRoot(sym.id);
      callees.pinRoot(sym.id);
      tracker.pin(sym);
      const view = which === "callers" ? callersView : calleesView;
      try { await view.reveal(undefined as any, { focus: true }); } catch { /* ignore */ }
    }),
    vscode.commands.registerCommand("callchain.lockCallers", () => {
      callers.setLocked(true);
      vscode.commands.executeCommand("setContext", "callchain.callersLocked", true);
      refreshCallersBadge();
    }),
    vscode.commands.registerCommand("callchain.unlockCallers", () => {
      callers.setLocked(false);
      vscode.commands.executeCommand("setContext", "callchain.callersLocked", false);
      // Snap back to the current cursor symbol if any.
      const cur = tracker.getCurrent();
      callers.setRoot(cur?.id);
      refreshCallersBadge();
    }),
    vscode.commands.registerCommand("callchain.lockCallees", () => {
      callees.setLocked(true);
      vscode.commands.executeCommand("setContext", "callchain.calleesLocked", true);
      refreshCalleesBadge();
    }),
    vscode.commands.registerCommand("callchain.unlockCallees", () => {
      callees.setLocked(false);
      vscode.commands.executeCommand("setContext", "callchain.calleesLocked", false);
      const cur = tracker.getCurrent();
      callees.setRoot(cur?.id);
      refreshCalleesBadge();
    }),
    vscode.commands.registerCommand("callchain.pickSymbol", async () => {
      const graph = indexer.getGraph();
      if (!graph) {
        vscode.window.showInformationMessage("Index not ready yet.");
        return;
      }
      const items = graph.allSymbols()
        .filter((s) => s.kind !== SymbolKind.Builtin && s.kind !== SymbolKind.Unresolved)
        .map((s) => ({
          label: s.name,
          description: s.ownerClass ? `${s.kind} · ${s.ownerClass}` : s.kind,
          detail: s.location.uri,
          symbol: s
        }));
      const picked = await vscode.window.showQuickPick(items, { matchOnDescription: true, placeHolder: "Search symbols…" });
      if (!picked) return;
      tracker.pin(picked.symbol);
      await openSymbol(picked.symbol);
    }),
    vscode.commands.registerCommand("callchain.openSymbol", async (symbolId: string, lineOverride?: number) => {
      const graph = indexer.getGraph();
      if (!graph) return;
      const sym = graph.symbol(symbolId);
      if (!sym) return;
      await openSymbol(sym, lineOverride);
    }),
    vscode.commands.registerCommand("callchain.showGraph", async (symbolId?: string) => {
      const graph = indexer.getGraph();
      if (!graph) {
        vscode.window.showInformationMessage("Index not ready yet.");
        return;
      }
      let rootId = symbolId;
      if (!rootId) rootId = tracker.getCurrent()?.id;
      if (!rootId) {
        vscode.window.showInformationMessage("Place the cursor on a 4D function/method first, or pick one.");
        return;
      }
      GraphPanel.show(context, graph, rootId);
    }),
    vscode.commands.registerCommand("callchain.contextShowCallers", (node: any) => {
      const sym = extractSymbol(node);
      if (!sym) return;
      callers.pinRoot(sym.id);
      callersView.reveal(undefined as any, { focus: true }).then(undefined, () => { /* ignore */ });
    }),
    vscode.commands.registerCommand("callchain.contextShowCallees", (node: any) => {
      const sym = extractSymbol(node);
      if (!sym) return;
      callees.pinRoot(sym.id);
      calleesView.reveal(undefined as any, { focus: true }).then(undefined, () => { /* ignore */ });
    }),
    vscode.commands.registerCommand("callchain.contextShowGraph", (node: any) => {
      const sym = extractSymbol(node);
      const graph = indexer.getGraph();
      if (!sym || !graph) return;
      GraphPanel.show(context, graph, sym.id);
    }),
    vscode.commands.registerCommand("callchain.contextPinCallers", (node: any) => {
      const sym = extractSymbol(node);
      if (!sym) return;
      callers.pinRoot(sym.id);
      callers.setLocked(true);
      vscode.commands.executeCommand("setContext", "callchain.callersLocked", true);
    }),
    vscode.commands.registerCommand("callchain.contextPinCallees", (node: any) => {
      const sym = extractSymbol(node);
      if (!sym) return;
      callees.pinRoot(sym.id);
      callees.setLocked(true);
      vscode.commands.executeCommand("setContext", "callchain.calleesLocked", true);
    }),
    vscode.commands.registerCommand("callchain.contextCopyName", async (node: any) => {
      const sym = extractSymbol(node);
      if (!sym) return;
      await vscode.env.clipboard.writeText(sym.name);
    }),
    vscode.commands.registerCommand("callchain.contextCopyFileLine", async (node: any) => {
      const sym = extractSymbol(node);
      if (!sym || !sym.location.uri) return;
      // file:///… → /abs/path:line
      const fsPath = vscode.Uri.parse(sym.location.uri).fsPath;
      const line = (sym.location.line ?? 0) + 1;
      await vscode.env.clipboard.writeText(`${fsPath}:${line}`);
    }),
    vscode.commands.registerCommand("callchain.filterCallers", () => openFilterInput("Filter Callers", callers)),
    vscode.commands.registerCommand("callchain.filterCallees", () => openFilterInput("Filter Callees", callees)),
    vscode.commands.registerCommand("callchain.filterSymbols", () => openFilterInput("Filter Symbols", search)),
    vscode.commands.registerCommand("callchain.clearFilterCallers", () => callers.setFilter("")),
    vscode.commands.registerCommand("callchain.clearFilterCallees", () => callees.setFilter("")),
    vscode.commands.registerCommand("callchain.clearFilterSymbols", () => search.setFilter("")),
    vscode.commands.registerCommand("callchain.toggleSymbolsSort", () => search.cycleSort()),
    vscode.commands.registerCommand("callchain.toggleCallerFilter", () => search.cycleCallerFilter()),
    vscode.commands.registerCommand("callchain.toggleFlattenSymbols", () => search.toggleFlatten()),
    vscode.commands.registerCommand("callchain.contextGroupByTheme", (node: any) => {
      if (node && node.kind === "group" && node.group?.kind) {
        search.toggleGroupByTheme(node.group.kind);
      }
    }),
    vscode.commands.registerCommand("callchain.resetSymbols", () => {
      search.resetAll();
      // resetAll fires filter/sort/caller-filter events; the existing
      // listeners re-sync context keys + badge.
    }),
    vscode.commands.registerCommand("callchain.collapseSubtree", (node: any) => {
      if (!node) return;
      // Folder nodes (groups + prefixes) only exist in the Symbols view.
      if (node.kind === "group" || node.kind === "prefix") {
        search.collapseSubtree(node);
        return;
      }
      // Root / SymbolGroup / Site come from a CallTreeProvider. The node's
      // own shape tells us which: but it doesn't say which direction. Both
      // providers accept the same Node shape, and only the matching one will
      // have the node's id in its expanded state — so we tell BOTH to bump
      // and let the unrelated provider no-op (bump for an unmounted scope
      // simply has no descendants to suffix).
      callers.collapseSubtree(node);
      callees.collapseSubtree(node);
    })
  );

  // Test-integration commands — registered only when the subsystem is enabled.
  if (testEnabled) {
    context.subscriptions.push(
      vscode.commands.registerCommand("callchain.runTestsForClass", async (className?: string, testFunctionName?: string) => {
        const cls = className ?? (await vscode.window.showInputBox({ prompt: "Test class name (e.g. OrderHydrator_Test)" }));
        if (!cls) return;
        // 1. If ScottHarris is installed, delegate to its Test Explorer.
        if (isScottHarrisInstalled()) {
          const classFile = path.join(projectRoot, "Project", "Sources", "Classes", `${cls}.4dm`);
          const ok = await delegateToScottHarris(classFile, testFunctionName, testOutput);
          if (ok) return;
        }
        // 2. Fall back to our own runner.
        const template = cfg.get<string>("testCommand", "make test class={class} format=json outputPath={jsonOutputPath}");
        const jsonRel = cfg.get<string>("jsonResultsPath", "Components/testing.4dbase/test-results/results.json");
        const cmd = template.replace(/\{jsonOutputPath\}/g, jsonRel);
        await runTests({ projectRoot, commandTemplate: cmd, className: cls, output: testOutput });
        const jsonAbs = path.join(projectRoot, jsonRel);
        decorator.loadFromJson(jsonAbs);
      }),
      vscode.commands.registerCommand("callchain.runAllTests", async () => {
        if (isScottHarrisInstalled()) {
          // Run all 4D tests in the global Test Explorer.
          await vscode.commands.executeCommand("testing.runAll");
          return;
        }
        const template = cfg
          .get<string>("testCommand", "make test class={class} format=json outputPath={jsonOutputPath}")
          .replace(/\bclass=\{class\}\s*/g, "");
        const jsonRel = cfg.get<string>("jsonResultsPath", "Components/testing.4dbase/test-results/results.json");
        const cmd = template.replace(/\{jsonOutputPath\}/g, jsonRel);
        await runTests({ projectRoot, commandTemplate: cmd, output: testOutput });
        const jsonAbs = path.join(projectRoot, jsonRel);
        decorator.loadFromJson(jsonAbs);
      }),
      vscode.commands.registerCommand("callchain.jumpToTests", async (symbolId: string) => {
        if (!coverage) return;
        const graph = indexer.getGraph();
        if (!graph) return;
        const tests = coverage.reachedByTests.get(symbolId);
        if (!tests || tests.size === 0) {
          vscode.window.showInformationMessage("No tests reach this symbol.");
          return;
        }
        const items = Array.from(tests).map((id) => {
          const s = graph.symbol(id);
          return {
            label: s?.name ?? id,
            description: s?.ownerClass ?? "",
            detail: s?.location.uri ?? "",
            symbol: s
          };
        });
        const picked = await vscode.window.showQuickPick(items, { placeHolder: `${tests.size} tests cover this symbol` });
        if (picked?.symbol) await openSymbol(picked.symbol);
      })
    );
  }

  if (vscode.workspace.getConfiguration("callchain").get<boolean>("autoIndexOnStartup", true)) {
    indexer.load().catch((err) => output.appendLine(`[Indexer] failed: ${err}`));
  }

  // Spawn the call-chain LSP server. Provides go-to-def, find-references,
  // workspace symbol, document symbol, and call hierarchy via standard LSP
  // methods — VSCode's native UIs (F12, Shift+F12, Peek Call Hierarchy) will
  // pick these up automatically once the document selector matches. Gated:
  // off by default, and a separate process that re-indexes independently.
  if (cfg.get<boolean>("languageServer.enabled", false)) {
    try {
      lspClient = startLanguageServer(context, output, exclusions, builtinConstantsPaths);
      context.subscriptions.push({ dispose: () => { void lspClient?.stop(); } });
    } catch (err) {
      output.appendLine(`[LSP] Failed to start language-server: ${err}`);
    }
  } else {
    output.appendLine("[Activate] language-server disabled (callchain.languageServer.enabled = false).");
  }

  // Spawn the IDE-features LSP server (hover today; completion / diagnostics
  // / semanticTokens later). Runs in its own process and indexes the same
  // workspace independently, sharing the on-disk cache file written by the
  // in-process call-chain indexer above. Gated: off by default.
  if (cfg.get<boolean>("ideServer.enabled", false)) {
    try {
      ideClient = startIdeServer(context, output, exclusions, builtinConstantsPaths);
      context.subscriptions.push({ dispose: () => { void ideClient?.stop(); } });
    } catch (err) {
      output.appendLine(`[IDE] Failed to start ide-server: ${err}`);
    }
  } else {
    output.appendLine("[Activate] ide-server disabled (callchain.ideServer.enabled = false).");
  }
}

export async function deactivate(): Promise<void> {
  await Promise.all([
    ideClient?.stop(),
    lspClient?.stop()
  ]);
  ideClient = undefined;
  lspClient = undefined;
}

/**
 * Bootstrap the @4d/language-server LSP client. Hosts the standard
 * navigation methods (definition / references / workspaceSymbol /
 * documentSymbol / callHierarchy).
 */
function startLanguageServer(
  _context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  exclusions: string[],
  builtinConstantsPaths: string[]
): LanguageClient {
  const serverModule = require.resolve("@4d/language-server/dist/bin.js");
  output.appendLine(`[LSP] Spawning language-server at ${serverModule}`);
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ["--nolazy", "--inspect=6011"] }
    }
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: "4d" }, { pattern: "**/*.4dm" }],
    initializationOptions: { exclusions, builtinConstantsPaths },
    synchronize: {
      fileEvents: [
        vscode.workspace.createFileSystemWatcher("**/*.4dm"),
        vscode.workspace.createFileSystemWatcher("**/Project/Sources/catalog.4DCatalog"),
        vscode.workspace.createFileSystemWatcher("**/Resources/Constants_*.xlf"),
        vscode.workspace.createFileSystemWatcher("**/Components/**/*.{4DZ,4dz}")
      ]
    },
    outputChannel: output
  };
  const client = new LanguageClient(
    "4dLanguageServer",
    "4D Language Server",
    serverOptions,
    clientOptions
  );
  void client.start();
  return client;
}

/**
 * Bootstrap the @4d/ide-server LSP client. The server bin resolves through
 * the workspace symlink — `require.resolve('@4d/ide-server/dist/bin.js')`
 * gives us the absolute path regardless of how the extension was packaged.
 */
function startIdeServer(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  exclusions: string[],
  builtinConstantsPaths: string[]
): LanguageClient {
  const serverModule = require.resolve("@4d/ide-server/dist/bin.js");
  output.appendLine(`[IDE] Spawning ide-server at ${serverModule}`);

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ["--nolazy", "--inspect=6010"] }
    }
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: "4d" }, { pattern: "**/*.4dm" }],
    initializationOptions: { exclusions, builtinConstantsPaths },
    synchronize: {
      fileEvents: [
        vscode.workspace.createFileSystemWatcher("**/*.4dm"),
        vscode.workspace.createFileSystemWatcher("**/Project/Sources/catalog.4DCatalog"),
        vscode.workspace.createFileSystemWatcher("**/Resources/Constants_*.xlf"),
        vscode.workspace.createFileSystemWatcher("**/Components/**/*.{4DZ,4dz}")
      ]
    },
    outputChannel: output
  };

  const client = new LanguageClient(
    "4dIdeServer",
    "4D IDE Server",
    serverOptions,
    clientOptions
  );
  void client.start();
  return client;
}

function resolveProjectRoot(): string | undefined {
  const cfg = vscode.workspace.getConfiguration("callchain").get<string>("projectRoot", "");
  if (cfg) return cfg;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return folders[0].uri.fsPath;
}

/**
 * Open a live-filtering InputBox bound to a tree provider. Every keystroke
 * applies the filter; Esc / Enter dismisses but the filter persists.
 * Use the matching clearFilter* command (visible as a title button when
 * filter is active) to reset.
 */
interface FilterableProvider {
  filter: string;
  setFilter(query: string): void;
}
function openFilterInput(title: string, provider: FilterableProvider): void {
  const input = vscode.window.createInputBox();
  input.title = title;
  input.placeholder = "Fuzzy match (chars in order)…";
  input.value = provider.filter;
  input.onDidChangeValue((v) => provider.setFilter(v));
  input.onDidAccept(() => input.hide());
  input.onDidHide(() => input.dispose());
  input.show();
}

/**
 * Pull a SymbolRecord out of whatever tree-node shape the context menu passes:
 *  - SymbolSearchProvider passes a raw SymbolRecord
 *  - CallTreeProvider passes a {symbol: SymbolRecord, ...} wrapper
 */
function extractSymbol(arg: any): SymbolRecord | undefined {
  if (!arg) return undefined;
  if (typeof arg === "string") return undefined;
  if (arg.kind && arg.name && arg.id) return arg as SymbolRecord;
  if (arg.symbol && typeof arg.symbol === "object") return arg.symbol as SymbolRecord;
  return undefined;
}

async function openSymbol(s: SymbolRecord, lineOverride?: number): Promise<void> {
  if (!s.location.uri) return;
  const uri = vscode.Uri.parse(s.location.uri);
  const doc = await vscode.workspace.openTextDocument(uri);
  const line = lineOverride ?? s.location.line ?? 0;
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0) });
}
