import * as vscode from "vscode";
import { CallGraph } from "../model/callGraph";
import { CallEdge, SymbolKind, SymbolRecord } from "../model/symbol";
import { descriptionFor, iconFor } from "./treeIcons";

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
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly rootChangedEmitter = new vscode.EventEmitter<string | undefined>();
  /** Fires whenever the effective root symbol id changes (after lock/unlock filtering). */
  readonly onDidChangeRoot = this.rootChangedEmitter.event;

  constructor(private readonly direction: Direction) {}

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
    for (const e of edges) {
      const targetId = this.direction === "callers" ? e.fromId : e.toId;
      if (parentChain.has(targetId)) continue;
      const sym = this.graph.symbol(targetId);
      if (!sym) continue;
      if (!allowConstantTargets && sym.kind === SymbolKind.Constant) continue;
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

    const groups = new Map<string, CallEdge[]>();
    for (const e of edges) {
      const targetId = this.direction === "callers" ? e.fromId : e.toId;
      if (parentChain.has(targetId)) continue;
      const sym = this.graph.symbol(targetId);
      if (!sym) continue;
      if (!allowConstantTargets && sym.kind === SymbolKind.Constant) continue;
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
