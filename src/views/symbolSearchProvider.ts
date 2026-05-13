import * as vscode from "vscode";
import { CallGraph } from "../model/callGraph";
import { SymbolKind, SymbolRecord } from "../model/symbol";
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

const ORDER: SymbolKind[] = [
  SymbolKind.ProjectMethod,
  SymbolKind.Class,
  SymbolKind.ClassFunction,
  SymbolKind.ClassConstructor,
  SymbolKind.ClassGetter,
  SymbolKind.ClassSetter,
  SymbolKind.DatabaseMethod,
  SymbolKind.FormMethod,
  SymbolKind.FormObjectMethod,
  SymbolKind.TableFormMethod,
  SymbolKind.TableObjectMethod,
  SymbolKind.CompilerMethod,
  SymbolKind.Constant,
  SymbolKind.Plugin,
  SymbolKind.Builtin,
  SymbolKind.Unresolved
];

/** Groups above this size are sub-divided by prefix. Smaller groups stay flat. */
const SUBGROUP_THRESHOLD = 100;

export class SymbolSearchProvider implements vscode.TreeDataProvider<Node> {
  private graph: CallGraph | undefined;
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  /** Cache symbol partitions per kind so getChildren stays O(1) after the first hit. */
  private readonly byKind = new Map<SymbolKind, SymbolRecord[]>();
  private readonly byKindAndPrefix = new Map<SymbolKind, Map<string, SymbolRecord[]>>();

  setGraph(graph: CallGraph): void {
    this.graph = graph;
    this.byKind.clear();
    this.byKindAndPrefix.clear();
    this.emitter.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (isGroup(node)) {
      const item = new vscode.TreeItem(`${node.group.label} (${node.count})`, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon("folder");
      return item;
    }
    if (isPrefix(node)) {
      const item = new vscode.TreeItem(node.prefix, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${node.count}`;
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
      const items = this.itemsForKind(node.group.kind);
      if (items.length <= SUBGROUP_THRESHOLD) {
        return [...items].sort((a, b) => a.name.localeCompare(b.name));
      }
      return this.partitionByPrefix(node.group.kind, items);
    }
    if (isPrefix(node)) {
      const buckets = this.byKindAndPrefix.get(node.symbolKind);
      const list = buckets?.get(node.prefix) ?? [];
      return [...list].sort((a, b) => a.name.localeCompare(b.name));
    }
    return [];
  }

  private itemsForKind(kind: SymbolKind): SymbolRecord[] {
    let cached = this.byKind.get(kind);
    if (!cached) {
      cached = [];
      for (const s of this.graph!.allSymbols()) {
        if (s.kind === kind) cached.push(s);
      }
      this.byKind.set(kind, cached);
    }
    return cached;
  }

  /** Build prefix → symbols map for a kind; cache for subsequent expansion. */
  private partitionByPrefix(kind: SymbolKind, items: SymbolRecord[]): Node[] {
    let buckets = this.byKindAndPrefix.get(kind);
    if (!buckets) {
      buckets = new Map<string, SymbolRecord[]>();
      const orphans: SymbolRecord[] = [];
      for (const s of items) {
        const p = prefixFor(s.name);
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
      this.byKindAndPrefix.set(kind, buckets);
    }
    const out: Node[] = [];
    for (const [prefix, list] of buckets) {
      if (prefix === "") continue; // orphans appended after sorted prefixes
      out.push(new PrefixNode(kind, prefix, list.length));
    }
    out.sort((a, b) => (a as PrefixNode).prefix.localeCompare((b as PrefixNode).prefix));
    const orphans = buckets.get("") ?? [];
    out.push(...[...orphans].sort((a, b) => a.name.localeCompare(b.name)));
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
