import * as path from "path";
import * as vscode from "vscode";
import { Indexer } from "./indexer/indexStore";
import { CallGraph } from "./model/callGraph";
import { SymbolKind, SymbolRecord } from "./model/symbol";
import { CallTreeProvider } from "./views/callTreeProvider";
import { SymbolSearchProvider } from "./views/symbolSearchProvider";
import { CursorTracker } from "./views/cursorTracker";
import { GraphPanel } from "./views/graphView/graphPanel";
import { TestStatusDecorator } from "./decorations/testStatusDecorator";
import { runTests } from "./testing/testRunner";
import { CoverageReport, computeCoverage } from "./testing/coverage";
import { CallChainLensProvider } from "./codelens/callChainLens";

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

  const exclusions = vscode.workspace.getConfiguration("callchain").get<string[]>("indexExclusions", []);
  const indexer = new Indexer({ projectRoot, exclusions, output });

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

  const lensProvider = new CallChainLensProvider(
    () => indexer.getGraph(),
    () => decorator,
    () => coverage
  );
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ pattern: "**/*.4dm" }, lensProvider)
  );

  // Wire indexer → views
  indexer.onDidUpdate((graph) => {
    callers.setGraph(graph);
    callees.setGraph(graph);
    search.setGraph(graph);
    tracker.setGraph(graph);
    coverage = computeCoverage(graph);
    lensProvider.refresh();
  });
  tracker.onDidChange((s) => {
    callers.setRoot(s?.id);
    callees.setRoot(s?.id);
  });

  // Watcher for test results
  const junitRel = vscode.workspace.getConfiguration("callchain").get<string>("junitResultsPath", "");
  if (junitRel) {
    const junitAbs = path.join(projectRoot, junitRel);
    decorator.loadFrom(junitAbs);
    decorator.onDidChange(() => lensProvider.refresh());
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(projectRoot, junitRel));
    watcher.onDidCreate(() => decorator.loadFrom(junitAbs));
    watcher.onDidChange(() => decorator.loadFrom(junitAbs));
    context.subscriptions.push(watcher);
  }

  // File-system watcher for .4dm changes → incremental rebuild
  const codeWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(projectRoot, "Project/Sources/**/*.4dm")
  );
  codeWatcher.onDidChange((uri) => indexer.patchFile(uri.fsPath));
  codeWatcher.onDidCreate((uri) => indexer.patchFile(uri.fsPath));
  codeWatcher.onDidDelete((uri) => indexer.patchFile(uri.fsPath));
  context.subscriptions.push(codeWatcher);

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
      tracker.pin(sym);
      const view = which === "callers" ? callersView : calleesView;
      try { await view.reveal(undefined as any, { focus: true }); } catch { /* ignore */ }
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
    vscode.commands.registerCommand("callchain.runTestsForClass", async (className?: string) => {
      const cls = className ?? (await vscode.window.showInputBox({ prompt: "Test class name (e.g. OrderHydrator_Test)" }));
      if (!cls) return;
      const template = vscode.workspace.getConfiguration("callchain").get<string>("testCommand", "make test class={class} format=junit");
      await runTests({ projectRoot, commandTemplate: template, className: cls, output: testOutput });
      const junitAbs = path.join(projectRoot, vscode.workspace.getConfiguration("callchain").get<string>("junitResultsPath", ""));
      decorator.loadFrom(junitAbs);
    }),
    vscode.commands.registerCommand("callchain.runAllTests", async () => {
      const template = vscode.workspace.getConfiguration("callchain").get<string>("testCommand", "make test class={class} format=junit").replace(/\bclass=\{class\}\s*/g, "");
      await runTests({ projectRoot, commandTemplate: template, output: testOutput });
      const junitAbs = path.join(projectRoot, vscode.workspace.getConfiguration("callchain").get<string>("junitResultsPath", ""));
      decorator.loadFrom(junitAbs);
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

  if (vscode.workspace.getConfiguration("callchain").get<boolean>("autoIndexOnStartup", true)) {
    indexer.load().catch((err) => output.appendLine(`[Indexer] failed: ${err}`));
  }
}

export function deactivate(): void {
  // Nothing — disposables registered with context.subscriptions are auto-disposed.
}

function resolveProjectRoot(): string | undefined {
  const cfg = vscode.workspace.getConfiguration("callchain").get<string>("projectRoot", "");
  if (cfg) return cfg;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return folders[0].uri.fsPath;
}

async function openSymbol(s: SymbolRecord, lineOverride?: number): Promise<void> {
  if (!s.location.uri) return;
  const uri = vscode.Uri.parse(s.location.uri);
  const doc = await vscode.workspace.openTextDocument(uri);
  const line = lineOverride ?? s.location.line ?? 0;
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0) });
}
