import * as vscode from "vscode";
import { CallGraph, ClassFlavor, SymbolKind, dispatchCallers, fuzzyMatch, parseFilterQuery } from "@4d/core";
import type { CallEdge, SymbolRecord } from "@4d/core";
import { descriptionFor, iconFor } from "./treeIcons";
import { DEFAULT_TEST_FUNCTION_PATTERN, DEFAULT_TEST_CLASS_PATTERN } from "../testing/coverage";

export type Direction = "callers" | "callees";

/** A group of call sites that share a target symbol (the caller, or callee). */
class SymbolGroup {
  readonly kind = "group" as const;
  constructor(
    public symbol: SymbolRecord,
    public edges: CallEdge[],
    public parentChain: Set<string>
  ) {}
}

/** A single call site (one line in source). Leaf node — no children. */
class CallSite {
  readonly kind = "site" as const;
  constructor(public symbol: SymbolRecord, public edge: CallEdge) {}
}

/**
 * A sub-grouping under a bundle root: "this caller, calling THIS specific
 * function of the bundle". Holds the called-function symbol and the subset
 * of edges into it; children are the actual call-site leaves.
 */
class CalleeGroup {
  readonly kind = "callee-group" as const;
  constructor(
    public callee: SymbolRecord,
    public caller: SymbolRecord,
    public edges: CallEdge[],
    public parentChain: Set<string>
  ) {}
}

/** Root marker — wraps the root symbol so the tree has a single seed node. */
class RootNode {
  readonly kind = "root" as const;
  constructor(public symbol: SymbolRecord) {}
}

/**
 * A polymorphic-dispatch group under a callers root: an ancestor `base` method
 * whose call sites (typed to the base) can dispatch to the overriding root at
 * runtime. Children are the dispatching callers — the same SymbolGroup layer
 * the direct callers use. Callers direction only.
 */
class ViaBaseGroup {
  readonly kind = "viabase" as const;
  constructor(public base: SymbolRecord, public sites: CallEdge[]) {}
}

type Node = SymbolGroup | CallSite | CalleeGroup | RootNode | ViaBaseGroup;

export type AccessFilter = "all" | "read" | "write";

/**
 * Test filter for the callers view: "all" shows every caller, "only" keeps only
 * callers that are tests, "exclude" hides them. Like the access filter it is
 * per-navigation — any root change clears it (so navigating via "N callers"
 * shows unfiltered callers); "only" is applied explicitly by the "tests cover
 * this" command, and the clear-all-filters button resets it on demand.
 */
export type TestFilter = "all" | "only" | "exclude";

/**
 * Field-like members whose inbound edges carry a read/write `access` tag. The
 * read/write access filter only applies (and is only offered) when the root is
 * one of these.
 */
const FIELD_LIKE_KINDS = new Set<SymbolKind>([
  SymbolKind.ClassProperty,
  SymbolKind.ClassGetter,
  SymbolKind.ClassSetter,
  SymbolKind.Alias
]);

export class CallTreeProvider implements vscode.TreeDataProvider<Node> {
  private rootSymbolId: string | undefined;
  private graph: CallGraph | undefined;
  private locked = false;
  /**
   * Per-symbol "collapse generation". When the user invokes "collapse
   * sub-folders" on a node, we bump that node's symbol id here. Any descendant
   * SymbolGroup whose parentChain contains a bumped ancestor gets the bump
   * appended to its TreeItem id — VS Code treats it as a fresh item and falls
   * back to the default `Collapsed` state.
   */
  private readonly collapseBumps = new Map<string, number>();
  private filterQuery = "";
  /**
   * When a filter is active, this is the set of symbol ids that should be
   * visible in the tree — every matching symbol plus every symbol that can
   * reach a matching one via the tree's direction. Recomputed when the
   * filter or graph changes.
   */
  private filterVisible: Set<string> | undefined;
  private filterMatchCount = 0;
  /**
   * Read/write access filter for a field-like root. "all" shows every usage;
   * "read"/"write" restrict the root's direct call sites to that access. Only
   * applied when the root is a field-like member (see {@link rootIsFieldLike}).
   */
  private accessFilterValue: AccessFilter = "all";
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly rootChangedEmitter = new vscode.EventEmitter<string | undefined>();
  /** Fires whenever the effective root symbol id changes (after lock/unlock filtering). */
  readonly onDidChangeRoot = this.rootChangedEmitter.event;
  private readonly filterChangedEmitter = new vscode.EventEmitter<string>();
  /** Fires whenever the active filter changes (string is empty when cleared). */
  readonly onDidChangeFilter = this.filterChangedEmitter.event;
  private readonly accessFilterChangedEmitter = new vscode.EventEmitter<AccessFilter>();
  /** Fires whenever the read/write access filter changes. */
  readonly onDidChangeAccessFilter = this.accessFilterChangedEmitter.event;
  /**
   * Tri-state test filter (see {@link TestFilter}) and the patterns used to
   * decide whether a caller is a test. Patterns default to the historical
   * conventions and are kept in sync with the coverage settings via
   * {@link setTestPatterns}.
   */
  private testFilterValue: TestFilter = "all";
  private testFnRe: RegExp = DEFAULT_TEST_FUNCTION_PATTERN;
  private testClassRe: RegExp = DEFAULT_TEST_CLASS_PATTERN;
  private readonly testFilterChangedEmitter = new vscode.EventEmitter<TestFilter>();
  /** Fires whenever the test filter changes. */
  readonly onDidChangeTestFilter = this.testFilterChangedEmitter.event;

  constructor(private readonly direction: Direction) {}

  get testFilter(): TestFilter {
    return this.testFilterValue;
  }

  setTestFilter(value: TestFilter): void {
    if (this.testFilterValue === value) return;
    this.testFilterValue = value;
    this.emitter.fire(undefined);
    this.testFilterChangedEmitter.fire(value);
  }

  /** Keep test detection in sync with the callchain.coverage.* regex settings. */
  setTestPatterns(testFnRe: RegExp, testClassRe: RegExp): void {
    this.testFnRe = testFnRe;
    this.testClassRe = testClassRe;
    if (this.testFilterValue !== "all") this.emitter.fire(undefined);
  }

  /** A symbol is a test if it's a test-flavored member, matches the test-function
   *  name pattern, or belongs to a class matching the test-class pattern. */
  private isTest(s: SymbolRecord): boolean {
    if (s.classFlavor === ClassFlavor.Test) return true;
    if (this.testFnRe.test(s.name)) return true;
    if (s.ownerClass && this.testClassRe.test(s.ownerClass)) return true;
    return false;
  }

  /** Test/non-test counts among the current root's direct callers (pre-test-filter). */
  testCounts(): { tests: number; nonTests: number } {
    if (!this.graph || !this.rootSymbolId) return { tests: 0, nonTests: 0 };
    const seen = new Map<string, boolean>();
    for (const e of this.baseRootEdges(this.rootSymbolId)) {
      const id = this.direction === "callers" ? e.fromId : e.toId;
      if (seen.has(id)) continue;
      const s = this.graph.symbol(id);
      seen.set(id, !!s && this.isTest(s));
    }
    let tests = 0;
    let nonTests = 0;
    for (const isT of seen.values()) isT ? tests++ : nonTests++;
    return { tests, nonTests };
  }

  get accessFilter(): AccessFilter {
    return this.accessFilterValue;
  }

  /** True when the current root is a field-like member (property/getter/setter/alias). */
  get rootIsFieldLike(): boolean {
    if (!this.graph || !this.rootSymbolId) return false;
    const s = this.graph.symbol(this.rootSymbolId);
    return !!s && FIELD_LIKE_KINDS.has(s.kind);
  }

  /** Read/write usage counts for the current field-like root (0/0 otherwise). */
  accessCounts(): { reads: number; writes: number } {
    if (!this.graph || !this.rootSymbolId || !this.rootIsFieldLike) return { reads: 0, writes: 0 };
    return {
      reads: this.graph.reads(this.rootSymbolId).length,
      writes: this.graph.writes(this.rootSymbolId).length
    };
  }

  setAccessFilter(value: AccessFilter): void {
    if (this.accessFilterValue === value) return;
    this.accessFilterValue = value;
    this.emitter.fire(undefined);
    this.accessFilterChangedEmitter.fire(value);
  }

  get filter(): string {
    return this.filterQuery;
  }

  get filterMatches(): number {
    return this.filterMatchCount;
  }

  setFilter(query: string): void {
    const next = query.trim();
    if (next === this.filterQuery) return;
    this.filterQuery = next;
    this.recomputeFilter();
    this.emitter.fire(undefined);
    this.filterChangedEmitter.fire(this.filterQuery);
  }

  private recomputeFilter(): void {
    if (!this.graph || !this.filterQuery) {
      this.filterVisible = undefined;
      this.filterMatchCount = 0;
      return;
    }
    const parsed = parseFilterQuery(this.filterQuery);
    const fuzzy = parsed.fuzzy;
    // Match: every symbol whose name satisfies the fuzzy query AND none of
    // the `-token` excludes. An empty positive query matches everything;
    // excludes still apply.
    const matches = new Set<string>();
    for (const s of this.graph.allSymbols()) {
      const haystack = s.ownerClass ? `${s.ownerClass}.${s.name}` : s.name;
      if (fuzzy && !fuzzyMatch(fuzzy, haystack)) continue;
      let excluded = false;
      for (const ex of parsed.excludes) {
        if (fuzzyMatch(ex, haystack)) { excluded = true; break; }
      }
      if (excluded) continue;
      matches.add(s.id);
    }
    this.filterMatchCount = matches.size;
    // Visible: every symbol that can reach (in this tree's direction) some match.
    //  - Callees tree: a parent P is visible iff some symbol in P's forward closure matches
    //    ⇒ P ∈ reverseClosure(matches) walking reverse edges of the forward graph,
    //    i.e. anything that calls into a match. CallGraph.reverseClosure walks .callers().
    //  - Callers tree: mirrored — a parent P is visible iff some caller-of-P (or further
    //    ancestor) matches ⇒ P ∈ forwardClosure(matches) walking .callees().
    this.filterVisible = this.direction === "callers"
      ? this.graph.forwardClosure(matches)
      : this.graph.reverseClosure(matches);
  }

  get isLocked(): boolean {
    return this.locked;
  }

  get rootId(): string | undefined {
    return this.rootSymbolId;
  }

  setLocked(value: boolean): void {
    this.locked = value;
  }

  setGraph(graph: CallGraph): void {
    this.graph = graph;
    this.bundleMemberCache.clear();
    this.recomputeFilter();
    this.emitter.fire(undefined);
    this.rootChangedEmitter.fire(this.rootSymbolId);
  }

  setRoot(symbolId: string | undefined): void {
    if (this.locked) return;
    if (this.rootSymbolId === symbolId) return;
    this.rootSymbolId = symbolId;
    this.resetFiltersOnRootChange();
    this.emitter.fire(undefined);
    this.rootChangedEmitter.fire(symbolId);
  }

  /** Force-set root regardless of lock state — used by explicit pin commands. */
  pinRoot(symbolId: string | undefined): void {
    if (this.rootSymbolId === symbolId) return;
    this.rootSymbolId = symbolId;
    this.resetFiltersOnRootChange();
    this.emitter.fire(undefined);
    this.rootChangedEmitter.fire(symbolId);
  }

  /**
   * The access and test filters are per-navigation, not persistent: any root
   * change (cursor move, "N callers" lens, pin) clears them so the new symbol's
   * callers show unfiltered. The only-tests filter is (re)applied explicitly
   * afterwards by the "tests cover this" command (setTestFilter), and the
   * clear-all button resets them on demand.
   */
  private resetFiltersOnRootChange(): void {
    if (this.accessFilterValue !== "all") {
      this.accessFilterValue = "all";
      this.accessFilterChangedEmitter.fire("all");
    }
    if (this.testFilterValue !== "all") {
      this.testFilterValue = "all";
      this.testFilterChangedEmitter.fire("all");
    }
  }

  /** Re-emit current tree without changing root — used by config changes. */
  refresh(): void {
    this.emitter.fire(undefined);
  }

  /**
   * Collapse every expanded descendant of `target` by bumping the generation
   * counter for target.symbol.id. Descendant SymbolGroups inherit the suffix
   * via their parentChain, get a new TreeItem id, and re-render Collapsed.
   */
  collapseSubtree(target: Node): void {
    if (target.kind === "site") return;
    const ancestorId =
      target.kind === "callee-group"
        ? target.callee.id
        : target.kind === "viabase"
          ? `viabase:${target.base.id}`
          : target.symbol.id;
    const prev = this.collapseBumps.get(ancestorId) ?? 0;
    this.collapseBumps.set(ancestorId, prev + 1);
    this.emitter.fire(undefined);
  }

  /** Count of direct callers/callees for the current root, or 0 if none. */
  directCount(): number {
    if (!this.graph || !this.rootSymbolId) return 0;
    const edges = this.rootEdges(this.rootSymbolId);
    const targets = new Set<string>();
    for (const e of edges) {
      targets.add(this.direction === "callers" ? e.fromId : e.toId);
    }
    return targets.size;
  }

  /**
   * Edges that should appear immediately under the root.
   *
   * For most symbols this is just `graph.callers(id)` / `graph.callees(id)`.
   * For *bundle-like* roots — Component bundles and component-owned Class
   * symbols — the direct edge count is near zero (calls land on the individual
   * functions, not the bundle), so we aggregate edges across every member of
   * the bundle. Without this rollup the Callers panel for a Component shows
   * nothing even when the bundle has thousands of inbound edges.
   */
  private rootEdges(rootId: string): CallEdge[] {
    let out = this.baseRootEdges(rootId);
    // Test filter — narrow the direct callers to (only|exclude) tests. Classifies
    // the caller side of each edge; for callees this is a no-op in practice since
    // only the callers view wires it up.
    if (this.testFilterValue !== "all" && this.graph) {
      out = out.filter((e) => {
        const id = this.direction === "callers" ? e.fromId : e.toId;
        const s = this.graph!.symbol(id);
        const t = !!s && this.isTest(s);
        return this.testFilterValue === "only" ? t : !t;
      });
    }
    return out;
  }

  /** Root's direct edges with bundle rollup + read/write access filter, before the test filter. */
  private baseRootEdges(rootId: string): CallEdge[] {
    if (!this.graph) return [];
    const root = this.graph.symbol(rootId);
    const memberIds = root ? this.bundleMemberIds(root) : undefined;
    let out: CallEdge[];
    if (!memberIds) {
      out = this.direction === "callers" ? this.graph.callers(rootId) : this.graph.callees(rootId);
    } else {
      out = [];
      for (const id of memberIds) {
        const edges = this.direction === "callers" ? this.graph.callers(id) : this.graph.callees(id);
        for (const e of edges) out.push(e);
      }
    }
    // Read/write filter — only meaningful for field-like roots, whose direct
    // edges carry an `access` tag. Gated on kind so a stale filter can never
    // hide a plain function's callers.
    if (this.accessFilterValue !== "all" && root && FIELD_LIKE_KINDS.has(root.kind)) {
      out = out.filter((e) => e.access === this.accessFilterValue);
    }
    return out;
  }

  /**
   * Return the member ids whose call edges should roll up under this symbol,
   * or `undefined` for a plain leaf. Caches by root id since membership is
   * stable across refreshes within one graph load.
   */
  private readonly bundleMemberCache = new Map<string, string[]>();
  private bundleMemberIds(root: SymbolRecord): string[] | undefined {
    if (!this.graph) return undefined;
    const cached = this.bundleMemberCache.get(root.id);
    if (cached) return cached;
    if (root.kind === SymbolKind.Component) {
      const ids: string[] = [];
      for (const s of this.graph.allSymbols()) {
        if (s.ownerComponent === root.name) ids.push(s.id);
      }
      this.bundleMemberCache.set(root.id, ids);
      return ids;
    }
    if (root.kind === SymbolKind.Class && root.ownerComponent) {
      // Component class: `Class:cs.<NS>.<Class>` — its members carry the
      // unprefixed form as ownerClass.
      const fq = root.id.replace(/^Class:/, "");
      const ids: string[] = [root.id];
      for (const s of this.graph.allSymbols()) {
        if (s.ownerClass === fq) ids.push(s.id);
      }
      this.bundleMemberCache.set(root.id, ids);
      return ids;
    }
    return undefined;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "root") {
      const hasChildren = this.hasNextLevel(node.symbol.id, new Set([node.symbol.id]));
      const item = new vscode.TreeItem(
        node.symbol.name,
        hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
      );
      // Stable id so VS Code preserves expansion state across refreshes
      // (e.g. when the fuzzy filter changes).
      item.id = `${this.direction}:root:${node.symbol.id}`;
      item.description = descriptionFor(node.symbol);
      item.iconPath = iconFor(node.symbol);
      item.command = {
        command: "callchain.openSymbol",
        title: "Open",
        arguments: [node.symbol.id]
      };
      item.contextValue = "callchain.symbol.root";
      return item;
    }
    if (node.kind === "callee-group") {
      const item = new vscode.TreeItem(
        node.callee.name,
        vscode.TreeItemCollapsibleState.Expanded
      );
      const path = [...node.parentChain].join(">");
      item.id = `${this.direction}:calleegrp:${path}>${node.callee.id}`;
      item.description = `${descriptionFor(node.callee)} · ×${node.edges.length}`;
      item.iconPath = iconFor(node.callee);
      item.tooltip = `${node.callee.name} (${node.callee.kind}) — ${node.edges.length} call site${node.edges.length === 1 ? "" : "s"}`;
      item.command = {
        command: "callchain.openSymbol",
        title: "Open",
        arguments: [node.callee.id]
      };
      item.contextValue = "callchain.calleegroup";
      return item;
    }
    if (node.kind === "viabase") {
      const label = node.base.ownerClass ? `${node.base.ownerClass}.${node.base.name}` : node.base.name;
      const item = new vscode.TreeItem(`via base ${label}`, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `${this.direction}:viabase:${this.rootSymbolId ?? ""}>${node.base.id}`;
      item.description = `· ×${node.sites.length}`;
      item.iconPath = new vscode.ThemeIcon("type-hierarchy-sub");
      item.tooltip = new vscode.MarkdownString(
        `Polymorphic dispatch — these call \`${label}\` (typed to the base) and can ` +
          `dispatch to this override at runtime. They are not direct callers.`
      );
      // Open the base method declaration.
      item.command = {
        command: "callchain.openSymbol",
        title: "Open",
        arguments: [node.base.id]
      };
      item.contextValue = "callchain.viabase";
      return item;
    }
    if (node.kind === "site") {
      const showSnippet = vscode.workspace
        .getConfiguration("callchain")
        .get<boolean>("showCallSiteSnippets", true);
      // Field-like-member edges carry a read/write access tag — surface it on
      // the call-site label (e.g. "line 160 · write").
      const accessTag = node.edge.access ? ` · ${node.edge.access}` : "";
      const item = new vscode.TreeItem(
        `line ${node.edge.line + 1}${accessTag}`,
        vscode.TreeItemCollapsibleState.None
      );
      item.id = `${this.direction}:site:${node.edge.fromId}>${node.edge.toId}@${node.edge.line}`;
      if (showSnippet) {
        item.description = truncate(node.edge.raw, 80);
      }
      item.iconPath = new vscode.ThemeIcon("debug-stackframe");
      item.tooltip = buildSiteTooltip(node);
      // Navigate to the call site itself — that lives in the FROM symbol's
      // file (the caller), regardless of which direction we're showing.
      item.command = {
        command: "callchain.openSymbol",
        title: "Open",
        arguments: [node.edge.fromId, node.edge.line]
      };
      item.contextValue = "callchain.site";
      return item;
    }
    // SymbolGroup
    const count = node.edges.length;
    let collapsible: vscode.TreeItemCollapsibleState;
    if (count >= 2) {
      // Multi-site: children are guaranteed (the call sites themselves). Auto-expand.
      collapsible = vscode.TreeItemCollapsibleState.Expanded;
    } else {
      // Single-site: only show a chevron if the next level has callers/callees.
      const nextChain = new Set(node.parentChain);
      nextChain.add(node.symbol.id);
      collapsible = this.hasNextLevel(node.symbol.id, nextChain)
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
    }
    const item = new vscode.TreeItem(node.symbol.name, collapsible);
    // Path-aware id so the same symbol appearing at different depths is
    // recognised as distinct. parentChain is iterated in insertion order
    // (Set preserves it) so the id is stable across refreshes.
    const path = [...node.parentChain].join(">");
    let groupId = `${this.direction}:grp:${path}>${node.symbol.id}`;
    // If any ancestor in this node's path has been collapsed via right-click,
    // append the bump suffix so VS Code forgets the old expansion state.
    for (const [ancestorId, bump] of this.collapseBumps) {
      if (node.parentChain.has(ancestorId)) {
        groupId += `:b${bump}@${ancestorId}`;
      }
    }
    item.id = groupId;
    const base = descriptionFor(node.symbol);
    item.description = count >= 2 ? `${base} · ×${count}` : base;
    item.iconPath = iconFor(node.symbol);
    item.tooltip = buildGroupTooltip(node);
    // Click jumps to the first call site so the user sees the call in context.
    // The call line lives in the FROM symbol's file (the caller), regardless of
    // tree direction — never the displayed `node.symbol`'s file when they differ.
    const firstEdge = node.edges[0];
    if (firstEdge) {
      item.command = {
        command: "callchain.openSymbol",
        title: "Open",
        arguments: [firstEdge.fromId, firstEdge.line]
      };
    } else if (node.symbol.location.uri) {
      item.command = {
        command: "callchain.openSymbol",
        title: "Open",
        arguments: [node.symbol.id]
      };
    }
    item.contextValue = count >= 2 ? "callchain.symbol.multi" : "callchain.symbol";
    return item;
  }

  /** True if expanding `symbolId` (with `parentChain` blocking cycles) would yield ≥1 group. */
  private hasNextLevel(symbolId: string, parentChain: Set<string>): boolean {
    if (!this.graph) return false;
    // A callers root that is an override may have only via-base (dispatch)
    // children and zero direct callers — still expandable.
    if (symbolId === this.rootSymbolId && this.viaBaseGroups(symbolId).length > 0) return true;
    const edges = symbolId === this.rootSymbolId
      ? this.rootEdges(symbolId)
      : (this.direction === "callers" ? this.graph.callers(symbolId) : this.graph.callees(symbolId));
    const rootSym = this.rootSymbolId ? this.graph.symbol(this.rootSymbolId) : undefined;
    const allowConstantTargets = rootSym?.kind === SymbolKind.Constant;
    const visible = this.filterVisible;
    for (const e of edges) {
      const targetId = this.direction === "callers" ? e.fromId : e.toId;
      if (parentChain.has(targetId)) continue;
      const sym = this.graph.symbol(targetId);
      if (!sym) continue;
      if (!allowConstantTargets && sym.kind === SymbolKind.Constant) continue;
      if (visible && !visible.has(targetId)) continue;
      return true;
    }
    return false;
  }

  getChildren(node?: Node): Node[] {
    if (!this.graph) return [];
    if (!node) {
      if (!this.rootSymbolId) return [];
      const root = this.graph.symbol(this.rootSymbolId);
      if (!root) return [];
      return [new RootNode(root)];
    }
    if (node.kind === "site") return [];
    if (node.kind === "callee-group") {
      const sites = [...node.edges]
        .sort((a, b) => a.line - b.line)
        .map((e) => new CallSite(node.caller, e));
      return sites;
    }
    if (node.kind === "viabase") {
      // Children are the dispatching callers, grouped like direct callers. The
      // synthetic `viabase:<base>` token in the chain keeps their TreeItem ids
      // distinct from any direct group for the same caller, and blocks cycles.
      const parentChain = new Set<string>([node.base.id, `viabase:${node.base.id}`]);
      if (this.rootSymbolId) parentChain.add(this.rootSymbolId);
      return this.groupEdgesIntoSymbols(node.sites, parentChain);
    }
    if (node.kind === "root") {
      // Via-base (polymorphic dispatch) groups lead, then the direct callers.
      return [
        ...this.viaBaseGroups(node.symbol.id),
        ...this.expandChildren(node.symbol.id, new Set([node.symbol.id]))
      ];
    }
    // SymbolGroup
    // When this group is a *direct* child of a bundle root (Component or a
    // component-owned Class), the rolled-up edges may target several distinct
    // members of the bundle. Insert a "called function" layer so the user can
    // see WHICH member each caller invokes.
    if (this.isDirectChildOfBundleRoot(node) && this.shouldSubgroupByCallee(node)) {
      return this.subgroupByCallee(node);
    }
    // While a read/write filter is active, a direct caller of the field-like
    // root should show its matching site leaf even when it's the only one —
    // the user is inspecting those exact sites, not drilling past them.
    const isDirectChildOfRoot =
      this.rootSymbolId !== undefined && node.parentChain.size === 1 && node.parentChain.has(this.rootSymbolId);
    const pinSites = this.accessFilterValue !== "all" && this.rootIsFieldLike && isDirectChildOfRoot;
    if (node.edges.length >= 2 || pinSites) {
      // Children are call-site leaves (one per edge), ordered by line.
      const sites = [...node.edges]
        .sort((a, b) => a.line - b.line)
        .map((e) => new CallSite(node.symbol, e));
      return sites;
    }
    // Single-site group: recurse to the next level of callers/callees.
    const parentChain = new Set(node.parentChain);
    parentChain.add(node.symbol.id);
    return this.expandChildren(node.symbol.id, parentChain);
  }

  /** Direct child of root = parentChain holds exactly the root id. */
  private isDirectChildOfBundleRoot(node: SymbolGroup): boolean {
    if (!this.graph || !this.rootSymbolId) return false;
    if (node.parentChain.size !== 1 || !node.parentChain.has(this.rootSymbolId)) return false;
    const root = this.graph.symbol(this.rootSymbolId);
    if (!root) return false;
    return root.kind === SymbolKind.Component
      || (root.kind === SymbolKind.Class && !!root.ownerComponent);
  }

  /** True when the group's edges target ≥2 distinct bundle members. */
  private shouldSubgroupByCallee(node: SymbolGroup): boolean {
    const seen = new Set<string>();
    const targetField: keyof CallEdge = this.direction === "callers" ? "toId" : "fromId";
    for (const e of node.edges) {
      seen.add(e[targetField] as string);
      if (seen.size > 1) return true;
    }
    return false;
  }

  private subgroupByCallee(node: SymbolGroup): CalleeGroup[] {
    if (!this.graph) return [];
    const targetField: keyof CallEdge = this.direction === "callers" ? "toId" : "fromId";
    const bucket = new Map<string, CallEdge[]>();
    for (const e of node.edges) {
      const key = e[targetField] as string;
      const arr = bucket.get(key) ?? [];
      arr.push(e);
      bucket.set(key, arr);
    }
    const nextChain = new Set(node.parentChain);
    nextChain.add(node.symbol.id);
    const out: CalleeGroup[] = [];
    for (const [id, edges] of bucket) {
      const sym = this.graph.symbol(id);
      if (!sym) continue;
      out.push(new CalleeGroup(sym, node.symbol, edges, nextChain));
    }
    out.sort((a, b) => b.edges.length - a.edges.length || a.callee.name.localeCompare(b.callee.name));
    return out;
  }

  private expandChildren(symbolId: string, parentChain: Set<string>): SymbolGroup[] {
    if (!this.graph) return [];
    const edges = symbolId === this.rootSymbolId
      ? this.rootEdges(symbolId)
      : (this.direction === "callers" ? this.graph.callers(symbolId) : this.graph.callees(symbolId));
    return this.groupEdgesIntoSymbols(edges, parentChain);
  }

  /**
   * Bucket a flat edge list into one `SymbolGroup` per other-end symbol (caller
   * for the callers tree, callee for the callees tree), applying the same
   * constant-skip, cycle-block, and active-filter rules everywhere. Shared by
   * the direct expansion and the via-base group expansion.
   */
  private groupEdgesIntoSymbols(edges: CallEdge[], parentChain: Set<string>): SymbolGroup[] {
    if (!this.graph) return [];
    // Constants are noise inside method call chains. Hide them everywhere
    // except when the tree itself is rooted on a Constant (the user explicitly
    // wants to see who references it).
    const rootSym = this.rootSymbolId ? this.graph.symbol(this.rootSymbolId) : undefined;
    const allowConstantTargets = rootSym?.kind === SymbolKind.Constant;

    const visible = this.filterVisible;
    const groups = new Map<string, CallEdge[]>();
    for (const e of edges) {
      const targetId = this.direction === "callers" ? e.fromId : e.toId;
      if (parentChain.has(targetId)) continue;
      const sym = this.graph.symbol(targetId);
      if (!sym) continue;
      if (!allowConstantTargets && sym.kind === SymbolKind.Constant) continue;
      if (visible && !visible.has(targetId)) continue; // filter hides this branch
      let bucket = groups.get(targetId);
      if (!bucket) {
        bucket = [];
        groups.set(targetId, bucket);
      }
      bucket.push(e);
    }
    const out: SymbolGroup[] = [];
    for (const [targetId, edgeList] of groups) {
      const sym = this.graph.symbol(targetId);
      if (!sym) continue;
      out.push(new SymbolGroup(sym, edgeList, parentChain));
    }
    out.sort((a, b) => {
      // Multi-site first so they're immediately visible.
      if ((a.edges.length >= 2) !== (b.edges.length >= 2)) {
        return a.edges.length >= 2 ? -1 : 1;
      }
      return a.symbol.name.localeCompare(b.symbol.name);
    });
    return out;
  }

  /**
   * Polymorphic-dispatch groups for the callers root: ancestor methods whose
   * call sites can dispatch to the overriding root. Empty unless this is a
   * callers tree rooted on an override with such sites.
   */
  private viaBaseGroups(rootId: string): ViaBaseGroup[] {
    if (!this.graph || this.direction !== "callers") return [];
    return dispatchCallers(this.graph, rootId).map((g) => new ViaBaseGroup(g.base, g.sites));
  }
}

function buildGroupTooltip(node: SymbolGroup): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${node.symbol.name}** _(${node.symbol.kind})_  \n`);
  if (node.symbol.ownerClass) md.appendMarkdown(`Owner: \`${node.symbol.ownerClass}\`  \n`);
  if (node.symbol.classFlavor) md.appendMarkdown(`Flavor: \`${node.symbol.classFlavor}\`  \n`);
  if (node.edges.length >= 2) md.appendMarkdown(`${node.edges.length} call sites in this file  \n`);
  return md;
}

function buildSiteTooltip(node: CallSite): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  const access = node.edge.access ? ` · ${node.edge.access}` : "";
  md.appendMarkdown(`**Line ${node.edge.line + 1}** — \`${node.edge.callKind}\`${access}  \n`);
  md.appendCodeblock(node.edge.raw, "4d");
  return md;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
