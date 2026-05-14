import * as vscode from "vscode";
import { CallGraph } from "../model/callGraph";
import { CallEdge, SymbolKind, SymbolRecord } from "../model/symbol";
import { descriptionFor, iconFor } from "./treeIcons";
import { fuzzyMatch, parseFilterQuery } from "../util/fuzzy";

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

/** Root marker — wraps the root symbol so the tree has a single seed node. */
class RootNode {
  readonly kind = "root" as const;
  constructor(public symbol: SymbolRecord) {}
}

type Node = SymbolGroup | CallSite | RootNode;

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
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly rootChangedEmitter = new vscode.EventEmitter<string | undefined>();
  /** Fires whenever the effective root symbol id changes (after lock/unlock filtering). */
  readonly onDidChangeRoot = this.rootChangedEmitter.event;
  private readonly filterChangedEmitter = new vscode.EventEmitter<string>();
  /** Fires whenever the active filter changes (string is empty when cleared). */
  readonly onDidChangeFilter = this.filterChangedEmitter.event;

  constructor(private readonly direction: Direction) {}

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
    this.recomputeFilter();
    this.emitter.fire(undefined);
    this.rootChangedEmitter.fire(this.rootSymbolId);
  }

  setRoot(symbolId: string | undefined): void {
    if (this.locked) return;
    if (this.rootSymbolId === symbolId) return;
    this.rootSymbolId = symbolId;
    this.emitter.fire(undefined);
    this.rootChangedEmitter.fire(symbolId);
  }

  /** Force-set root regardless of lock state — used by explicit pin commands. */
  pinRoot(symbolId: string | undefined): void {
    if (this.rootSymbolId === symbolId) return;
    this.rootSymbolId = symbolId;
    this.emitter.fire(undefined);
    this.rootChangedEmitter.fire(symbolId);
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
    const ancestorId = target.symbol.id;
    const prev = this.collapseBumps.get(ancestorId) ?? 0;
    this.collapseBumps.set(ancestorId, prev + 1);
    this.emitter.fire(undefined);
  }

  /** Count of direct callers/callees for the current root, or 0 if none. */
  directCount(): number {
    if (!this.graph || !this.rootSymbolId) return 0;
    const edges =
      this.direction === "callers"
        ? this.graph.callers(this.rootSymbolId)
        : this.graph.callees(this.rootSymbolId);
    const targets = new Set<string>();
    for (const e of edges) {
      targets.add(this.direction === "callers" ? e.fromId : e.toId);
    }
    return targets.size;
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
    if (node.kind === "site") {
      const showSnippet = vscode.workspace
        .getConfiguration("callchain")
        .get<boolean>("showCallSiteSnippets", true);
      const item = new vscode.TreeItem(
        `line ${node.edge.line + 1}`,
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
    const edges =
      this.direction === "callers"
        ? this.graph.callers(symbolId)
        : this.graph.callees(symbolId);
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
    if (node.kind === "root") {
      return this.expandChildren(node.symbol.id, new Set([node.symbol.id]));
    }
    // SymbolGroup
    if (node.edges.length >= 2) {
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

  private expandChildren(symbolId: string, parentChain: Set<string>): SymbolGroup[] {
    if (!this.graph) return [];
    const edges =
      this.direction === "callers"
        ? this.graph.callers(symbolId)
        : this.graph.callees(symbolId);

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
  md.appendMarkdown(`**Line ${node.edge.line + 1}** — \`${node.edge.callKind}\`  \n`);
  md.appendCodeblock(node.edge.raw, "4d");
  return md;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
