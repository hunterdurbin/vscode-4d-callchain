import * as vscode from "vscode";
import { CallGraph, SymbolKind, fuzzyMatch, parseFilterQuery } from "@4d/core";
import type { SymbolRecord, ParsedQuery } from "@4d/core";
import { descriptionFor, iconFor } from "./treeIcons";

interface SymbolGroup {
  kind: SymbolKind;
  label: string;
}

class GroupNode {
  readonly kind = "group" as const;
  constructor(public group: SymbolGroup, public count: number) {}
}

class PrefixNode {
  readonly kind = "prefix" as const;
  constructor(public symbolKind: SymbolKind, public prefix: string, public count: number) {}
}

type Node = GroupNode | PrefixNode | SymbolRecord;

export type SortMode = "name" | "callersDesc" | "callersAsc";
export type CallerCountFilter = "off" | "withCallers" | "noCallers";

const ORDER: SymbolKind[] = [
  SymbolKind.ProjectMethod,
  SymbolKind.Class,
  SymbolKind.ClassFunction,
  SymbolKind.ClassConstructor,
  SymbolKind.ClassGetter,
  SymbolKind.ClassSetter,
  SymbolKind.DatabaseMethod,
  SymbolKind.Form,
  SymbolKind.FormMethod,
  SymbolKind.FormObjectMethod,
  SymbolKind.TableForm,
  SymbolKind.TableFormMethod,
  SymbolKind.TableObjectMethod,
  SymbolKind.CompilerMethod,
  SymbolKind.InterprocessVariable,
  SymbolKind.ProcessVariable,
  SymbolKind.Constant,
  SymbolKind.BuiltinConstant,
  SymbolKind.Plugin,
  SymbolKind.PluginCommand,
  SymbolKind.Component,
  SymbolKind.ComponentMethod,
  SymbolKind.Builtin,
  SymbolKind.Unresolved
];

/** Groups above this size are sub-divided by prefix. Smaller groups stay flat. */
const SUBGROUP_THRESHOLD = 100;


export class SymbolSearchProvider implements vscode.TreeDataProvider<Node> {
  private graph: CallGraph | undefined;
  private filterQuery = "";
  private parsedFilter: ParsedQuery = { fuzzy: "", excludes: [] };
  private sortMode: SortMode = "name";
  private callerCountFilter: CallerCountFilter = "off";
  /** When true, every kind group expands directly to its symbols — no prefix sub-folders. */
  private flattenPrefixes = false;
  /**
   * Kinds for which the sub-folders are themes (Constant.theme /
   * BuiltinConstant.theme) rather than name prefixes. Defaults include both
   * constant kinds since their XLF themes are far more useful than prefix
   * fragments; user can right-click → Group by theme to toggle off.
   */
  private readonly themeGroupedKinds = new Set<SymbolKind>([
    SymbolKind.Constant,
    SymbolKind.BuiltinConstant
  ]);
  /** Bump generation per group/prefix scope so right-click "collapse" forces fresh ids on descendants. */
  private readonly collapseBumps = new Map<string, number>();
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly filterChangedEmitter = new vscode.EventEmitter<string>();
  readonly onDidChangeFilter = this.filterChangedEmitter.event;
  private readonly sortChangedEmitter = new vscode.EventEmitter<SortMode>();
  readonly onDidChangeSort = this.sortChangedEmitter.event;
  private readonly callerFilterChangedEmitter = new vscode.EventEmitter<CallerCountFilter>();
  readonly onDidChangeCallerFilter = this.callerFilterChangedEmitter.event;
  private readonly flattenChangedEmitter = new vscode.EventEmitter<boolean>();
  readonly onDidChangeFlatten = this.flattenChangedEmitter.event;
  /** Cache symbol partitions per kind so getChildren stays O(1) after the first hit. */
  private readonly byKind = new Map<SymbolKind, SymbolRecord[]>();
  private readonly byKindAndPrefix = new Map<SymbolKind, Map<string, SymbolRecord[]>>();

  get filter(): string {
    return this.filterQuery;
  }

  get currentSort(): SortMode {
    return this.sortMode;
  }

  get currentCallerFilter(): CallerCountFilter {
    return this.callerCountFilter;
  }

  get isFlat(): boolean {
    return this.flattenPrefixes;
  }

  setFilter(query: string): void {
    const next = query.trim();
    if (next === this.filterQuery) return;
    this.filterQuery = next;
    this.parsedFilter = parseFilterQuery(next);
    // Partition caches are keyed by SymbolKind only; invalidate them so the
    // count badges on prefix folders reflect the current filter state.
    this.byKindAndPrefix.clear();
    this.emitter.fire(undefined);
    this.filterChangedEmitter.fire(this.filterQuery);
  }

  /** Cycle sort mode: Name → CallersDesc → CallersAsc → Name → … */
  cycleSort(): void {
    this.sortMode =
      this.sortMode === "name" ? "callersDesc" :
      this.sortMode === "callersDesc" ? "callersAsc" : "name";
    this.emitter.fire(undefined);
    this.sortChangedEmitter.fire(this.sortMode);
  }

  /**
   * Collapse every expanded descendant of the right-clicked group or prefix
   * by bumping the generation for that scope. Descendant TreeItem ids get
   * the bump suffix and VS Code re-renders them with default Collapsed state.
   */
  collapseSubtree(node: Node): void {
    let scope: string | undefined;
    if (isGroup(node)) scope = `group:${node.group.kind}`;
    else if (isPrefix(node)) scope = `prefix:${node.symbolKind}:${node.prefix}`;
    if (!scope) return;
    this.collapseBumps.set(scope, (this.collapseBumps.get(scope) ?? 0) + 1);
    this.emitter.fire(undefined);
  }

  /** Suffix to append to a descendant's id when any of its ancestor scopes have been collapsed. */
  private bumpSuffixFor(...scopes: string[]): string {
    let suffix = "";
    for (const s of scopes) {
      const b = this.collapseBumps.get(s);
      if (b) suffix += `:b${b}@${s}`;
    }
    return suffix;
  }

  /** Toggle prefix sub-folders on/off for every kind group. */
  toggleFlatten(): void {
    this.flattenPrefixes = !this.flattenPrefixes;
    this.emitter.fire(undefined);
    this.flattenChangedEmitter.fire(this.flattenPrefixes);
  }

  /** True if this kind's sub-folders are themes (rather than name prefixes). */
  isGroupedByTheme(kind: SymbolKind): boolean {
    return this.themeGroupedKinds.has(kind);
  }

  /**
   * Reset every interactive setting (filter, sort, caller-filter, flatten,
   * theme grouping, collapse bumps) back to the default state and fire all
   * change events so badges + context keys re-sync.
   */
  resetAll(): void {
    this.filterQuery = "";
    this.parsedFilter = { fuzzy: "", excludes: [] };
    this.sortMode = "name";
    this.callerCountFilter = "off";
    this.flattenPrefixes = false;
    // Restore the default theme-grouping for constant kinds (matches what the
    // user gets on a fresh tree).
    this.themeGroupedKinds.clear();
    this.themeGroupedKinds.add(SymbolKind.Constant);
    this.themeGroupedKinds.add(SymbolKind.BuiltinConstant);
    this.collapseBumps.clear();
    this.byKindAndPrefix.clear();
    this.emitter.fire(undefined);
    this.filterChangedEmitter.fire("");
    this.sortChangedEmitter.fire("name");
    this.callerFilterChangedEmitter.fire("off");
    this.flattenChangedEmitter.fire(false);
  }

  /** Toggle theme-based sub-folder grouping for a specific kind. */
  toggleGroupByTheme(kind: SymbolKind): void {
    if (this.themeGroupedKinds.has(kind)) this.themeGroupedKinds.delete(kind);
    else this.themeGroupedKinds.add(kind);
    // Invalidate the partition cache for this kind so it rebuilds with the new key.
    this.byKindAndPrefix.delete(kind);
    this.emitter.fire(undefined);
  }

  /** Cycle caller-count quick filter: off → withCallers (≥1) → noCallers (=0) → off → … */
  cycleCallerFilter(): void {
    this.callerCountFilter =
      this.callerCountFilter === "off" ? "withCallers" :
      this.callerCountFilter === "withCallers" ? "noCallers" : "off";
    this.byKindAndPrefix.clear();
    this.emitter.fire(undefined);
    this.callerFilterChangedEmitter.fire(this.callerCountFilter);
  }

  private matches(s: SymbolRecord): boolean {
    const haystack = s.ownerClass ? `${s.ownerClass}.${s.name}` : s.name;
    if (this.callerCountFilter !== "off" && this.graph) {
      const n = this.graph.callers(s.id).length;
      if (this.callerCountFilter === "withCallers" && n < 1) return false;
      if (this.callerCountFilter === "noCallers" && n !== 0) return false;
    }
    if (this.parsedFilter.callerPredicate && this.graph) {
      const n = this.graph.callers(s.id).length;
      if (!this.parsedFilter.callerPredicate(n)) return false;
    }
    for (const ex of this.parsedFilter.excludes) {
      if (fuzzyMatch(ex, haystack)) return false;
    }
    if (!this.parsedFilter.fuzzy) return true;
    return fuzzyMatch(this.parsedFilter.fuzzy, haystack);
  }

  private callerCount(s: SymbolRecord): number {
    if (s.kind === SymbolKind.Plugin) {
      return this.childrenForBundle(s).reduce(
        (n, c) => n + (this.graph?.callers(c.id).length ?? 0),
        0
      );
    }
    if (s.kind === SymbolKind.Component) {
      return this.childrenForBundle(s).reduce(
        (n, c) => n + (this.graph?.callers(c.id).length ?? 0),
        0
      );
    }
    return this.graph?.callers(s.id).length ?? 0;
  }

  /** PluginCommand or ComponentMethod children for a Plugin / Component bundle. */
  private readonly childrenByBundle = new Map<string, SymbolRecord[]>();
  private childrenForBundle(bundle: SymbolRecord): SymbolRecord[] {
    const key = `${bundle.kind}:${bundle.name}`;
    let cached = this.childrenByBundle.get(key);
    if (!cached) {
      cached = [];
      if (this.graph) {
        if (bundle.kind === SymbolKind.Plugin) {
          for (const s of this.graph.allSymbols()) {
            if (s.kind === SymbolKind.PluginCommand && s.ownerPlugin === bundle.name) cached.push(s);
          }
        } else if (bundle.kind === SymbolKind.Component) {
          for (const s of this.graph.allSymbols()) {
            if (s.ownerComponent !== bundle.name) continue;
            // Show ComponentMethods + Class symbols (the discoverable exports
            // of the component). Skip ClassFunction/Constructor — those are
            // reachable via call hierarchy or workspace symbol search.
            if (s.kind === SymbolKind.ComponentMethod || s.kind === SymbolKind.Class) {
              cached.push(s);
            }
          }
        }
      }
      this.childrenByBundle.set(key, cached);
    }
    return cached;
  }

  /** Bucket key for a symbol — theme if its kind is theme-grouped, else the name prefix. */
  private groupKeyFor(s: SymbolRecord): string | undefined {
    if (this.themeGroupedKinds.has(s.kind)) return s.constantTheme;
    if (s.kind === SymbolKind.PluginCommand) return s.ownerPlugin;
    if (s.kind === SymbolKind.ComponentMethod) return s.ownerComponent;
    return prefixFor(s.name);
  }

  /** Sort a list of symbols according to the current sort mode. */
  private sortItems(items: SymbolRecord[]): SymbolRecord[] {
    if (this.sortMode === "callersDesc" || this.sortMode === "callersAsc") {
      const dir = this.sortMode === "callersDesc" ? -1 : 1;
      return [...items].sort((a, b) => {
        const ca = this.callerCount(a);
        const cb = this.callerCount(b);
        if (ca !== cb) return dir * (ca - cb);
        return a.name.localeCompare(b.name);
      });
    }
    return [...items].sort((a, b) => a.name.localeCompare(b.name));
  }

  setGraph(graph: CallGraph): void {
    this.graph = graph;
    this.byKind.clear();
    this.byKindAndPrefix.clear();
    this.childrenByBundle.clear();
    this.emitter.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (isGroup(node)) {
      const themed = this.themeGroupedKinds.has(node.group.kind);
      const labelSuffix = themed ? " · by theme" : "";
      const item = new vscode.TreeItem(`${node.group.label} (${node.count})${labelSuffix}`, vscode.TreeItemCollapsibleState.Collapsed);
      // Stable id so VS Code preserves expansion state across tree refreshes
      // (filter typing, sort changes, etc.).
      item.id = `group:${node.group.kind}${themed ? ":theme" : ""}`;
      item.iconPath = new vscode.ThemeIcon("folder");
      // Encode kind so per-kind context menus (Group by theme on Constants only)
      // can match via the `when` clause.
      item.contextValue = `callchain.folder.group.${node.group.kind}`;
      return item;
    }
    if (isPrefix(node)) {
      const item = new vscode.TreeItem(node.prefix, vscode.TreeItemCollapsibleState.Collapsed);
      // Inherit bump from parent group if it was collapsed.
      item.id = `prefix:${node.symbolKind}:${node.prefix}${this.bumpSuffixFor(`group:${node.symbolKind}`)}`;
      item.description = `${node.count}`;
      item.iconPath = new vscode.ThemeIcon("folder");
      item.contextValue = "callchain.folder.prefix";
      return item;
    }
    // Plugin and Component bundles are collapsible — expanding shows their
    // PluginCommand / ComponentMethod children. Everything else stays a leaf.
    const isBundle = node.kind === SymbolKind.Plugin || node.kind === SymbolKind.Component;
    const collapsible = isBundle && this.childrenForBundle(node).length > 0
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.name, collapsible);
    // Inherit bumps from both the symbol's kind group and its prefix folder.
    const groupKey = this.groupKeyFor(node);
    const scopes = [`group:${node.kind}`];
    if (groupKey) scopes.push(`prefix:${node.kind}:${groupKey}`);
    item.id = `sym:${node.id}${this.bumpSuffixFor(...scopes)}`;
    const baseDesc = descriptionFor(node);
    const callers = this.callerCount(node);
    item.description = callers > 0 ? `${baseDesc} · ▲ ${callers}` : baseDesc;
    item.iconPath = iconFor(node);
    if (node.kind === SymbolKind.Constant || node.kind === SymbolKind.BuiltinConstant) {
      // Constants all "live" in the same XLF file — navigation there is useless.
      // Clicking pins the constant as the Callers root so the real-world value
      // (where it's used) shows up immediately.
      item.command = {
        command: "callchain.contextShowCallers",
        title: "Show callers",
        arguments: [node]
      };
    } else {
      item.command = {
        command: "callchain.openSymbol",
        title: "Open",
        arguments: [node.id]
      };
    }
    item.contextValue = "callchain.symbol";
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!this.graph) return [];
    if (!node) {
      // Count only filter-matching symbols per kind; hide empty groups when filtered.
      const counts = new Map<SymbolKind, number>();
      for (const s of this.graph.allSymbols()) {
        if (!this.matches(s)) continue;
        counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
      }
      return ORDER.filter((k) => (counts.get(k) ?? 0) > 0).map(
        (k) => new GroupNode({ kind: k, label: k }, counts.get(k)!)
      );
    }
    if (isGroup(node)) {
      const items = this.itemsForKind(node.group.kind).filter((s) => this.matches(s));
      if (this.flattenPrefixes || items.length <= SUBGROUP_THRESHOLD) {
        return this.sortItems(items);
      }
      return this.partitionByPrefix(node.group.kind, items);
    }
    if (isPrefix(node)) {
      // Bypass the cached prefix map when filtering — caches are built off
      // the unfiltered set. Rebuild on the fly from the filter-matching items.
      const items = this.itemsForKind(node.symbolKind).filter((s) => this.matches(s));
      const list = items.filter((s) => this.groupKeyFor(s) === node.prefix);
      return this.sortItems(list);
    }
    // Plugin or Component bundle → expand to its commands / methods.
    if (node.kind === SymbolKind.Plugin || node.kind === SymbolKind.Component) {
      const children = this.childrenForBundle(node).filter((s) => this.matches(s));
      return this.sortItems(children);
    }
    return [];
  }

  private itemsForKind(kind: SymbolKind): SymbolRecord[] {
    let cached = this.byKind.get(kind);
    if (!cached) {
      cached = [];
      for (const s of this.graph!.allSymbols()) {
        if (s.kind !== kind) continue;
        // Component-owned class symbols (Class, ClassFunction, ClassConstructor,
        // ClassGetter, ClassSetter) are nested under their Component bundle —
        // don't double-count them in the top-level kind folders.
        if (s.ownerComponent && s.kind !== SymbolKind.ComponentMethod) continue;
        cached.push(s);
      }
      this.byKind.set(kind, cached);
    }
    return cached;
  }

  /**
   * Build prefix → symbols map for a kind. Caches the unfiltered partition so
   * repeated expansion of the same group stays O(1); recomputes on the fly
   * when a filter is active (items already filtered upstream).
   *
   * When the kind is in `themeGroupedKinds`, the bucket key is the symbol's
   * `constantTheme` instead of the name prefix.
   */
  private partitionByPrefix(kind: SymbolKind, items: SymbolRecord[]): Node[] {
    const filterActive = this.filterQuery.length > 0;
    const byTheme = this.themeGroupedKinds.has(kind);
    let buckets = filterActive ? undefined : this.byKindAndPrefix.get(kind);
    if (!buckets) {
      buckets = new Map<string, SymbolRecord[]>();
      const orphans: SymbolRecord[] = [];
      for (const s of items) {
        const p = byTheme ? s.constantTheme : prefixFor(s.name);
        if (p) {
          let arr = buckets.get(p);
          if (!arr) { arr = []; buckets.set(p, arr); }
          arr.push(s);
        } else {
          orphans.push(s);
        }
      }
      // Demote singleton prefixes back into orphans so we don't create
      // one-item sub-folders. Keeps the tree from looking spammy.
      for (const [p, list] of Array.from(buckets.entries())) {
        if (list.length === 1) {
          orphans.push(list[0]);
          buckets.delete(p);
        }
      }
      if (orphans.length > 0) {
        // Store the un-prefixed leaves under a synthetic empty-string key so
        // they're available alongside real prefixes.
        buckets.set("", orphans);
      }
      if (!filterActive) this.byKindAndPrefix.set(kind, buckets);
    }
    const out: Node[] = [];
    for (const [prefix, list] of buckets) {
      if (prefix === "") continue; // orphans appended after sorted prefixes
      out.push(new PrefixNode(kind, prefix, list.length));
    }
    out.sort((a, b) => (a as PrefixNode).prefix.localeCompare((b as PrefixNode).prefix));
    const orphans = buckets.get("") ?? [];
    out.push(...this.sortItems(orphans));
    return out;
  }
}

function isGroup(n: Node): n is GroupNode {
  return (n as GroupNode).kind === "group";
}

function isPrefix(n: Node): n is PrefixNode {
  return (n as PrefixNode).kind === "prefix";
}

/**
 * Derive a grouping prefix from a symbol name. Patterns covered:
 *   - "Form.objectMethod"           → "Form"
 *   - "_TableName__Field"           → "_TableName"
 *   - "_TableNameΩrelated"          → "_TableName"
 *   - "WebOrder_Process"            → "WebOrder"
 *   - "HTTP Get"                    → "HTTP"
 *   - "Char Backslash"              → "Char"
 * Returns undefined when there's no obvious prefix (single short token).
 */
function prefixFor(name: string): string | undefined {
  if (!name) return undefined;
  const dot = name.indexOf(".");
  if (dot > 0) return name.slice(0, dot);
  if (name.startsWith("_")) {
    // Match leading "_Foo" then stop at "_", " ", or any non-alphanumeric.
    const m = name.match(/^_[A-Za-z0-9]+/);
    if (m) return m[0];
  }
  const sp = name.indexOf(" ");
  if (sp > 0) return name.slice(0, sp);
  const us = name.indexOf("_");
  if (us > 0) return name.slice(0, us);
  return undefined;
}
