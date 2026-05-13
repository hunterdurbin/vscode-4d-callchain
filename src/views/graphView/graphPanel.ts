import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { CallGraph } from "../../model/callGraph";
import { CallKind, SymbolKind } from "../../model/symbol";

interface GraphData {
  rootId: string;
  rootLabel: string;
  nodes: { id: string; label: string; kind: SymbolKind; ownerClass?: string; uri: string; line: number }[];
  edges: { id: string; source: string; target: string; kind: CallKind; resolved: boolean }[];
}

export class GraphPanel {
  private static current: GraphPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, graph: CallGraph, rootId: string): GraphPanel {
    if (this.current) {
      this.current.panel.reveal();
      this.current.update(graph, rootId);
      return this.current;
    }
    const panel = vscode.window.createWebviewPanel(
      "callchainGraph",
      "4D Call Chain",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(context.extensionPath, "src", "views", "graphView", "webview")),
          vscode.Uri.file(path.join(context.extensionPath, "node_modules", "cytoscape", "dist")),
          vscode.Uri.file(path.join(context.extensionPath, "node_modules", "cytoscape-dagre")),
          vscode.Uri.file(path.join(context.extensionPath, "node_modules", "dagre", "dist"))
        ]
      }
    );
    this.current = new GraphPanel(panel, context, graph, rootId);
    return this.current;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private graph: CallGraph,
    private rootId: string
  ) {
    this.panel = panel;
    this.panel.webview.html = this.renderHtml();
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg), undefined, this.disposables);
  }

  update(graph: CallGraph, rootId: string): void {
    this.graph = graph;
    this.rootId = rootId;
    this.postData();
  }

  private postData(): void {
    const depth = vscode.workspace.getConfiguration("callchain").get<number>("maxGraphDepth", 3);
    this.panel.webview.postMessage({ type: "data", payload: this.buildData(this.rootId, depth, "both") });
  }

  private buildData(rootId: string, depth: number, direction: "forward" | "reverse" | "both"): GraphData {
    const root = this.graph.symbol(rootId);
    if (!root) {
      return { rootId, rootLabel: rootId, nodes: [], edges: [] };
    }
    const { nodes, edges } = this.graph.reachable(rootId, depth, direction);
    const nodeList: GraphData["nodes"] = [];
    for (const id of nodes) {
      const s = this.graph.symbol(id);
      if (!s) continue;
      nodeList.push({
        id: s.id,
        label: s.name,
        kind: s.kind,
        ownerClass: s.ownerClass,
        uri: s.location.uri,
        line: s.location.line
      });
    }
    const edgeList: GraphData["edges"] = edges.map((e, i) => ({
      id: `e${i}`,
      source: e.fromId,
      target: e.toId,
      kind: e.callKind,
      resolved: e.resolved
    }));
    return { rootId, rootLabel: root.name, nodes: nodeList, edges: edgeList };
  }

  private handleMessage(msg: { type: string; payload?: any }): void {
    if (msg.type === "ready") {
      this.postData();
    } else if (msg.type === "openSymbol") {
      vscode.commands.executeCommand("callchain.openSymbol", msg.payload?.id);
    } else if (msg.type === "rebuild") {
      const { direction, depth } = msg.payload;
      this.panel.webview.postMessage({
        type: "data",
        payload: this.buildData(this.rootId, depth, direction)
      });
    } else if (msg.type === "setRoot") {
      this.rootId = msg.payload?.id ?? this.rootId;
      this.postData();
    }
  }

  private renderHtml(): string {
    const ext = this.context.extensionPath;
    const root = path.join(ext, "src", "views", "graphView", "webview");
    const cytoscapeJs = this.toWebUri(path.join(ext, "node_modules", "cytoscape", "dist", "cytoscape.min.js"));
    const dagreJs     = this.toWebUri(path.join(ext, "node_modules", "dagre", "dist", "dagre.min.js"));
    const cyDagreJs   = this.toWebUri(path.join(ext, "node_modules", "cytoscape-dagre", "cytoscape-dagre.js"));
    const indexCss    = this.toWebUri(path.join(root, "graph.css"));
    const indexJs     = this.toWebUri(path.join(root, "graph.js"));
    const csp = `default-src 'none'; img-src ${this.panel.webview.cspSource} https:; script-src ${this.panel.webview.cspSource} 'unsafe-inline'; style-src ${this.panel.webview.cspSource} 'unsafe-inline';`;
    return /* html */`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${indexCss}">
  <title>4D Call Chain</title>
</head>
<body>
  <div id="toolbar">
    <label>Direction <select id="direction">
      <option value="both" selected>Both</option>
      <option value="forward">Callees ▶</option>
      <option value="reverse">◀ Callers</option>
    </select></label>
    <label>Depth <input id="depth" type="range" min="1" max="6" value="3"><span id="depthVal">3</span></label>
    <label>Layout <select id="layout">
      <option value="dagre" selected>Hierarchical</option>
      <option value="cose">Organic</option>
      <option value="breadthfirst">Breadth-first</option>
      <option value="concentric">Concentric</option>
    </select></label>
    <input id="filter" type="search" placeholder="Filter nodes by name…">
    <button id="fit">Fit</button>
    <span id="stats"></span>
  </div>
  <div id="legend">
    <span class="dot k-ProjectMethod"></span>Method
    <span class="dot k-ClassFunction"></span>Class fn
    <span class="dot k-ClassConstructor"></span>Constructor
    <span class="dot k-Class"></span>Class
    <span class="dot k-DatabaseMethod"></span>DB
    <span class="dot k-FormMethod"></span>Form
    <span class="dot k-FormObjectMethod"></span>Form obj
    <span class="dot k-Builtin"></span>Built-in
    <span class="dot k-Plugin"></span>Plugin
    <span class="dot k-Unresolved"></span>Unresolved
  </div>
  <div id="cy"></div>
  <script src="${cytoscapeJs}"></script>
  <script src="${dagreJs}"></script>
  <script src="${cyDagreJs}"></script>
  <script src="${indexJs}"></script>
</body>
</html>`;
  }

  private toWebUri(absPath: string): string {
    return this.panel.webview.asWebviewUri(vscode.Uri.file(absPath)).toString();
  }

  dispose(): void {
    GraphPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
  }
}
