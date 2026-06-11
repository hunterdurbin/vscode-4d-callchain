import * as vscode from "vscode";
import { CallTreeProvider } from "./callTreeProvider";
import { SymbolSearchProvider } from "./symbolSearchProvider";
import { CursorTracker } from "./cursorTracker";

/** The tree providers + views + badge refreshers the rest of the extension wires against. */
export interface Views {
  callers: CallTreeProvider;
  callees: CallTreeProvider;
  search: SymbolSearchProvider;
  tracker: CursorTracker;
  callersView: vscode.TreeView<unknown>;
  calleesView: vscode.TreeView<unknown>;
  refreshCallersBadge: () => void;
  refreshCalleesBadge: () => void;
}

/**
 * Create the three tree views (Callers / Callees / Symbols) plus the cursor
 * tracker, wire their badges and menu context keys, and react to the
 * tree-rendering config. The indexer→view graph wiring stays in the
 * composition root (extension.ts) because it crosses into coverage/lenses.
 */
export function registerViews(context: vscode.ExtensionContext): Views {
  const callers = new CallTreeProvider("callers");
  const callees = new CallTreeProvider("callees");
  const search = new SymbolSearchProvider();
  const tracker = new CursorTracker();

  const callersView = vscode.window.createTreeView("callchain.callers", { treeDataProvider: callers });
  const calleesView = vscode.window.createTreeView("callchain.callees", { treeDataProvider: callees });
  const searchView = vscode.window.createTreeView("callchain.search", { treeDataProvider: search });
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
    let desc = buildBadge(callers.directCount(), callers.isLocked, callers.filter, callers.filterMatches);
    if (callers.rootIsFieldLike && callers.accessFilter !== "all") {
      const tag = `↔${callers.accessFilter}`;
      desc = desc ? `${desc} ${tag}` : tag;
    }
    if (callers.testFilter !== "all") {
      const tag = callers.testFilter === "only" ? "🧪only" : "🧪excl";
      desc = desc ? `${desc} ${tag}` : tag;
    }
    callersView.description = desc;
    // Drives visibility of the read/write filter button in the view title.
    vscode.commands.executeCommand("setContext", "callchain.callersFieldLike", callers.rootIsFieldLike);
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
    callers.onDidChangeAccessFilter((a) => {
      vscode.commands.executeCommand("setContext", "callchain.callersAccessFiltered", a !== "all");
      refreshCallersBadge();
    }),
    callers.onDidChangeTestFilter((t) => {
      vscode.commands.executeCommand("setContext", "callchain.callersTestFiltered", t !== "all");
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
  vscode.commands.executeCommand("setContext", "callchain.callersFieldLike", false);
  vscode.commands.executeCommand("setContext", "callchain.callersAccessFiltered", false);
  vscode.commands.executeCommand("setContext", "callchain.callersTestFiltered", false);

  // React to config changes that affect tree rendering.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("callchain.showCallSiteSnippets")) {
        callers.refresh();
        callees.refresh();
      }
    })
  );

  tracker.onDidChange((s) => {
    callers.setRoot(s?.id);
    callees.setRoot(s?.id);
  });

  return { callers, callees, search, tracker, callersView, calleesView, refreshCallersBadge, refreshCalleesBadge };
}
