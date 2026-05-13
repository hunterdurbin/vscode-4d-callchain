import * as vscode from "vscode";
import { CallGraph } from "../model/callGraph";
import { CallEdge, SymbolRecord } from "../model/symbol";
import { descriptionFor, iconFor } from "./treeIcons";

export type Direction = "callers" | "callees";

class TreeNode {
  constructor(
    public symbol: SymbolRecord,
    public edge?: CallEdge,
    public parentChain: Set<string> = new Set()
  ) {}
}

export class CallTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private rootSymbolId: string | undefined;
  private graph: CallGraph | undefined;
  private locked = false;
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
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

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.symbol.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.description = descriptionFor(node.symbol);
    item.iconPath = iconFor(node.symbol);
    item.tooltip = buildTooltip(node);
    if (node.symbol.location.uri) {
      item.command = {
        command: "callchain.openSymbol",
        title: "Open",
        arguments: [node.symbol.id, node.edge?.line]
      };
    }
    item.contextValue = "callchain.symbol";
    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!this.graph) return [];
    if (!node) {
      if (!this.rootSymbolId) return [];
      const root = this.graph.symbol(this.rootSymbolId);
      if (!root) return [];
      return [new TreeNode(root)];
    }
    const seen = new Set(node.parentChain);
    seen.add(node.symbol.id);
    const edges =
      this.direction === "callers"
        ? this.graph.callers(node.symbol.id)
        : this.graph.callees(node.symbol.id);

    const out: TreeNode[] = [];
    const dedupe = new Set<string>();
    for (const e of edges) {
      const targetId = this.direction === "callers" ? e.fromId : e.toId;
      if (dedupe.has(targetId)) continue;
      dedupe.add(targetId);
      const sym = this.graph.symbol(targetId);
      if (!sym) continue;
      out.push(new TreeNode(sym, e, seen));
    }
    // Mark items that would recurse with a non-expandable state
    out.sort((a, b) => a.symbol.name.localeCompare(b.symbol.name));
    return out;
  }
}

function buildTooltip(node: TreeNode): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${node.symbol.name}** _(${node.symbol.kind})_  \n`);
  if (node.symbol.ownerClass) md.appendMarkdown(`Owner: \`${node.symbol.ownerClass}\`  \n`);
  if (node.symbol.classFlavor) md.appendMarkdown(`Flavor: \`${node.symbol.classFlavor}\`  \n`);
  if (node.edge) {
    md.appendMarkdown(`Call: \`${node.edge.callKind}\` at line ${node.edge.line + 1}  \n`);
    md.appendCodeblock(node.edge.raw, "4d");
  }
  return md;
}
