import * as vscode from "vscode";
import type { Views } from "../views/registerViews";

/** Filter / sort / flatten / collapse commands for the three tree views. */
export function registerFilterCommands(context: vscode.ExtensionContext, views: Views): void {
  const { callers, callees, search } = views;

  context.subscriptions.push(
    vscode.commands.registerCommand("callchain.filterCallers", () => openFilterInput("Filter Callers", callers)),
    vscode.commands.registerCommand("callchain.filterCallersAccess", async () => {
      const { reads, writes } = callers.accessCounts();
      const cur = callers.accessFilter;
      const mark = (v: "all" | "read" | "write") => (cur === v ? "$(check) " : "$(blank) ");
      type Item = vscode.QuickPickItem & { value: "all" | "read" | "write" };
      const items: Item[] = [
        { label: `${mark("all")}All usages`, value: "all", description: `${reads + writes} site${reads + writes === 1 ? "" : "s"}` },
        { label: `${mark("read")}Reads only`, value: "read", description: `${reads} read${reads === 1 ? "" : "s"}` },
        { label: `${mark("write")}Writes only`, value: "write", description: `${writes} write${writes === 1 ? "" : "s"}` }
      ];
      const pick = await vscode.window.showQuickPick(items, {
        title: "Filter callers by read / write",
        placeHolder: "Show only read or only write usages of this member"
      });
      if (pick) callers.setAccessFilter(pick.value);
    }),
    vscode.commands.registerCommand("callchain.filterCallersTests", async () => {
      const { tests, nonTests } = callers.testCounts();
      const cur = callers.testFilter;
      const mark = (v: "all" | "only" | "exclude") => (cur === v ? "$(check) " : "$(blank) ");
      type Item = vscode.QuickPickItem & { value: "all" | "only" | "exclude" };
      const items: Item[] = [
        { label: `${mark("all")}All callers`, value: "all", description: `${tests + nonTests} caller${tests + nonTests === 1 ? "" : "s"}` },
        { label: `${mark("only")}Only tests`, value: "only", description: `${tests} test${tests === 1 ? "" : "s"}` },
        { label: `${mark("exclude")}Exclude tests`, value: "exclude", description: `${nonTests} non-test${nonTests === 1 ? "" : "s"}` }
      ];
      const pick = await vscode.window.showQuickPick(items, {
        title: "Filter callers by tests",
        placeHolder: "Show all callers, only tests, or exclude tests"
      });
      if (pick) callers.setTestFilter(pick.value);
    }),
    vscode.commands.registerCommand("callchain.filterCallees", () => openFilterInput("Filter Callees", callees)),
    vscode.commands.registerCommand("callchain.filterSymbols", () => openFilterInput("Filter Symbols", search)),
    vscode.commands.registerCommand("callchain.clearFilterCallers", () => {
      callers.setFilter("");
      callers.setAccessFilter("all");
      callers.setTestFilter("all");
    }),
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
