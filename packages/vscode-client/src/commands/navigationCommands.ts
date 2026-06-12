import * as vscode from "vscode";
import { Indexer, SymbolKind } from "@4d/core";
import type { SymbolRecord } from "@4d/core";
import { TracePanel } from "../views/traceView/tracePanel";
import { descendantClasses, findOverriddenFunction, findOverridesOfFunction } from "../codelens/overrides";
import type { Views } from "../views/registerViews";

/**
 * Navigation / pin / lock / peek / graph commands and the context-menu
 * commands the tree views contribute.
 */
export function registerNavigationCommands(
  context: vscode.ExtensionContext,
  indexer: Indexer,
  views: Views,
  output: vscode.OutputChannel
): void {
  const { callers, callees, tracker, callersView, calleesView, refreshCallersBadge, refreshCalleesBadge } = views;

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
      // Show the full caller list — clear the only-tests filter even when we're
      // already on this symbol (so pinRoot's root-change reset didn't fire).
      callers.setTestFilter("all");
      // `<viewId>.focus` opens the activity-bar container and focuses the view —
      // `view.reveal` only scrolls within an already-visible tree, so it can't
      // bring the pane forward when it's hidden behind another view.
      const focusCmd = which === "callers" ? "callchain.callers.focus" : "callchain.callees.focus";
      try { await vscode.commands.executeCommand(focusCmd); } catch { /* ignore */ }
    }),
    // Invoked by the "ⓘ N tests cover this" lens: pin the symbol and show only
    // its test callers.
    vscode.commands.registerCommand("callchain.showTestCallers", async (symbolId: string) => {
      const graph = indexer.getGraph();
      if (!graph) return;
      const sym = graph.symbol(symbolId);
      if (!sym) return;
      callers.pinRoot(sym.id);
      callees.pinRoot(sym.id);
      tracker.pin(sym);
      callers.setTestFilter("only");
      try { await vscode.commands.executeCommand("callchain.callers.focus"); } catch { /* ignore */ }
      refreshCallersBadge();
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
    vscode.commands.registerCommand(
      "callchain.openSymbol",
      async (symbolId: string, lineOverride?: number, columnOverride?: number, endColumnOverride?: number) => {
        const graph = indexer.getGraph();
        if (!graph) return;
        const sym = graph.symbol(symbolId);
        if (!sym) return;
        await openSymbol(sym, lineOverride, columnOverride, endColumnOverride);
      }
    ),
    vscode.commands.registerCommand("callchain.showOverrides", async (symbolId: string, anchorLine?: number) => {
      const graph = indexer.getGraph();
      if (!graph) return;
      const base = graph.symbol(symbolId);
      if (!base) return;
      const overrides = findOverridesOfFunction(graph, symbolId);
      if (overrides.length === 0) {
        vscode.window.showInformationMessage("No subclasses override this function.");
        return;
      }
      await peekSymbols(base.location.uri, anchorLine ?? base.location.line ?? 0, overrides);
    }),
    vscode.commands.registerCommand("callchain.showOverridden", async (symbolId: string, anchorLine?: number) => {
      const graph = indexer.getGraph();
      if (!graph) return;
      const base = graph.symbol(symbolId);
      if (!base) return;
      const overridden = findOverriddenFunction(graph, symbolId);
      if (!overridden) {
        vscode.window.showInformationMessage("This function does not override an inherited function.");
        return;
      }
      await peekSymbols(base.location.uri, anchorLine ?? base.location.line ?? 0, [overridden]);
    }),
    vscode.commands.registerCommand("callchain.showSubclasses", async (symbolId: string, anchorLine?: number) => {
      const graph = indexer.getGraph();
      if (!graph) return;
      const cls = graph.symbol(symbolId);
      if (!cls) return;
      const subs = descendantClasses(graph, cls.name);
      if (subs.length === 0) {
        vscode.window.showInformationMessage("No classes extend this class.");
        return;
      }
      await peekSymbols(cls.location.uri, anchorLine ?? cls.location.line ?? 0, subs);
    }),
    vscode.commands.registerCommand("callchain.showTrace", async (symbolId?: unknown) => {
      const graph = indexer.getGraph();
      if (!graph) {
        vscode.window.showInformationMessage("Index not ready yet.");
        return;
      }
      // From the editor context menu VS Code passes the document Uri, not a
      // symbol id — only trust a string and fall back to the cursor symbol.
      let rootId = typeof symbolId === "string" ? symbolId : undefined;
      if (!rootId) rootId = tracker.getCurrent()?.id;
      if (!rootId) {
        vscode.window.showInformationMessage("Place the cursor on a 4D function/method first, or pick one.");
        return;
      }
      TracePanel.show(context, graph, rootId);
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
    vscode.commands.registerCommand("callchain.contextShowTrace", (node: any) => {
      const sym = extractSymbol(node);
      const graph = indexer.getGraph();
      if (!sym || !graph) return;
      TracePanel.show(context, graph, sym.id);
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
    })
  );
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

export async function openSymbol(
  s: SymbolRecord,
  lineOverride?: number,
  columnOverride?: number,
  endColumnOverride?: number
): Promise<void> {
  if (!s.location.uri) return;
  const uri = vscode.Uri.parse(s.location.uri);
  const doc = await vscode.workspace.openTextDocument(uri);
  // When a lineOverride is given (call site), it lives on a different line than
  // the symbol definition, so fall back to column 0 — never borrow the symbol's
  // own definition column. Without an override, select the identifier itself.
  const usingLineOverride = lineOverride !== undefined;
  const line = usingLineOverride ? lineOverride : s.location.line ?? 0;
  const col = columnOverride ?? (usingLineOverride ? 0 : s.location.column ?? 0);
  const endCol = endColumnOverride ?? (usingLineOverride ? col : s.location.endColumn ?? col);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, col, line, endCol) });
}

/**
 * Show `targets` in VS Code's native peek widget, anchored at (anchorUri,
 * anchorLine) — the file/line of the clicked code lens. Used by the override /
 * extended-by lenses so results preview inline instead of navigating away.
 */
async function peekSymbols(anchorUri: string, anchorLine: number, targets: SymbolRecord[]): Promise<void> {
  if (!anchorUri || targets.length === 0) return;
  const uri = vscode.Uri.parse(anchorUri);
  // Ensure the anchor doc is the active editor so the peek opens in it.
  await vscode.window.showTextDocument(uri, { preserveFocus: false });
  const position = new vscode.Position(anchorLine, 0);
  const locations = targets
    .filter((t) => t.location.uri)
    .map(
      (t) =>
        new vscode.Location(
          vscode.Uri.parse(t.location.uri),
          new vscode.Position(t.location.line ?? 0, t.location.column ?? 0)
        )
    );
  await vscode.commands.executeCommand("editor.action.peekLocations", uri, position, locations, "peek");
}
