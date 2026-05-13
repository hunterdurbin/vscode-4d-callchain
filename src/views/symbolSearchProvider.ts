import * as vscode from "vscode";
import { CallGraph } from "../model/callGraph";
import { SymbolKind, SymbolRecord } from "../model/symbol";
import { descriptionFor, iconFor } from "./treeIcons";

interface SymbolGroup {
  kind: SymbolKind;
  label: string;
}

class GroupNode {
  constructor(public group: SymbolGroup, public count: number) {}
}

type Node = GroupNode | SymbolRecord;

function isGroup(n: Node): n is GroupNode {
  return (n as GroupNode).group !== undefined;
}

const ORDER: SymbolKind[] = [
  SymbolKind.ProjectMethod,
  SymbolKind.Class,
  SymbolKind.ClassFunction,
  SymbolKind.ClassConstructor,
  SymbolKind.DatabaseMethod,
  SymbolKind.FormMethod,
  SymbolKind.FormObjectMethod,
  SymbolKind.TableFormMethod,
  SymbolKind.TableObjectMethod,
  SymbolKind.CompilerMethod,
  SymbolKind.Plugin,
  SymbolKind.Builtin,
  SymbolKind.Unresolved
];

export class SymbolSearchProvider implements vscode.TreeDataProvider<Node> {
  private graph: CallGraph | undefined;
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  setGraph(graph: CallGraph): void {
    this.graph = graph;
    this.emitter.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (isGroup(node)) {
      const item = new vscode.TreeItem(`${node.group.label} (${node.count})`, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon("folder");
      return item;
    }
    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
    item.description = descriptionFor(node);
    item.iconPath = iconFor(node);
    item.command = {
      command: "callchain.openSymbol",
      title: "Open",
      arguments: [node.id]
    };
    item.contextValue = "callchain.symbol";
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!this.graph) return [];
    if (!node) {
      const counts = new Map<SymbolKind, number>();
      for (const s of this.graph.allSymbols()) {
        counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
      }
      return ORDER.filter((k) => (counts.get(k) ?? 0) > 0).map(
        (k) => new GroupNode({ kind: k, label: k }, counts.get(k)!)
      );
    }
    if (isGroup(node)) {
      const items: SymbolRecord[] = [];
      for (const s of this.graph.allSymbols()) {
        if (s.kind === node.group.kind) items.push(s);
      }
      items.sort((a, b) => a.name.localeCompare(b.name));
      return items.slice(0, 500); // cap UI; QuickPick handles the rest
    }
    return [];
  }
}
