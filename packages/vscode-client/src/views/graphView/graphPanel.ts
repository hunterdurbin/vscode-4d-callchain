import * as vscode from "vscode";
import { maxGraphDepth } from "../../config";
import { CallGraph } from "@4d/core";
import { buildButterfly } from "./butterflyData";
import { resolveWebviewAssets } from "../webviewAssets";

export class GraphPanel {
  private static current: GraphPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  // Trail and history persist for the panel's lifetime.
  private readonly visited = new Set<string>();
  private history: string[] = [];
  private historyIndex = -1;
  private depth = maxGraphDepth();

  static show(context: vscode.ExtensionContext, graph: CallGraph, rootId: string): GraphPanel {
    if (this.current) {
      this.current.panel.reveal();
      this.current.graph = graph;
      this.current.recenter(rootId);
      return this.current;
    }
    const assets = resolveWebviewAssets(context, "graph");
    const panel = vscode.window.createWebviewPanel(
      "callchainGraph",
      "4D Butterfly Graph",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: assets.roots
      }
    );
    this.current = new GraphPanel(panel, context, graph, rootId);
    return this.current;
  }

  /** Re-render an open panel against a fresh graph after a reindex. */
  static refreshIfOpen(graph: CallGraph): void {
    const p = this.current;
    if (!p) return;
    p.graph = graph;
    if (!graph.symbol(p.centerId())) {
      // Current center vanished — fall back to the most recent history entry
      // that still resolves.
      for (let i = p.historyIndex; i >= 0; i--) {
        if (graph.symbol(p.history[i])) {
          p.historyIndex = i;
          break;
        }
      }
    }
    p.postData();
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private graph: CallGraph,
    rootId: string
  ) {
    this.panel = panel;
    this.history = [rootId];
    this.historyIndex = 0;
    this.visited.add(rootId);
    this.panel.webview.html = this.renderHtml();
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg), undefined, this.disposables);
  }

  private centerId(): string {
    return this.history[this.historyIndex];
  }

  private recenter(symbolId: string): void {
    if (symbolId !== this.centerId()) {
      this.history = this.history.slice(0, this.historyIndex + 1);
      this.history.push(symbolId);
      this.historyIndex = this.history.length - 1;
    }
    this.visited.add(symbolId);
    this.postData();
  }

  private postData(): void {
    const data = buildButterfly(this.graph, this.centerId(), this.depth, this.visited, {
      back: this.historyIndex > 0,
      fwd: this.historyIndex < this.history.length - 1
    });
    this.panel.title = `4D Butterfly — ${data.centerLabel}`;
    this.panel.webview.postMessage({ type: "data", payload: { ...data, depth: this.depth } });
  }

  private handleMessage(msg: { type: string; payload?: any }): void {
    switch (msg.type) {
      case "ready":
        this.postData();
        break;
      case "recenter":
        if (typeof msg.payload?.symbolId === "string") this.recenter(msg.payload.symbolId);
        break;
      case "openSymbol":
        vscode.commands.executeCommand("callchain.openSymbol", msg.payload?.symbolId);
        break;
      case "setDepth": {
        const d = Number(msg.payload?.depth);
        if (Number.isFinite(d) && d >= 1 && d <= 4) {
          this.depth = d;
          this.postData();
        }
        break;
      }
      case "back":
        if (this.historyIndex > 0) {
          this.historyIndex--;
          this.postData();
        }
        break;
      case "forward":
        if (this.historyIndex < this.history.length - 1) {
          this.historyIndex++;
          this.postData();
        }
        break;
      case "clearTrail":
        this.visited.clear();
        this.visited.add(this.centerId());
        this.postData();
        break;
    }
  }

  private renderHtml(): string {
    const assets = resolveWebviewAssets(this.context, "graph");
    const cytoscapeJs = this.toWebUri(assets.vendor("cytoscape.min.js"));
    const indexCss = this.toWebUri(assets.file("graph.css"));
    const indexJs = this.toWebUri(assets.file("graph.js"));
    const csp = `default-src 'none'; img-src ${this.panel.webview.cspSource} https:; script-src ${this.panel.webview.cspSource} 'unsafe-inline'; style-src ${this.panel.webview.cspSource} 'unsafe-inline';`;
    return /* html */ `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${indexCss}">
  <title>4D Butterfly Graph</title>
</head>
<body>
  <div id="toolbar">
    <button id="back" title="Back to previous center">◀</button>
    <button id="forward" title="Forward">▶</button>
    <label>Depth per side <input id="depth" type="range" min="1" max="4" value="${this.depth}"><span id="depthVal">${this.depth}</span></label>
    <input id="filter" type="search" placeholder="Filter nodes by name…">
    <button id="fit">Fit</button>
    <button id="clearTrail" title="Forget which nodes were visited">Clear trail</button>
    <span id="truncated" title="Graph was capped; increase focus or lower depth" hidden>⚠ truncated</span>
    <span id="stats"></span>
  </div>
  <div id="legend">
    <span class="dot k-ProjectMethod"></span>Method
    <span class="dot k-ClassFunction"></span>Class fn
    <span class="dot k-ClassConstructor"></span>Constructor
    <span class="dot k-ClassGetter"></span>Getter
    <span class="dot k-ClassSetter"></span>Setter
    <span class="dot k-Class"></span>Class
    <span class="dot k-DatabaseMethod"></span>DB
    <span class="dot k-FormMethod"></span>Form
    <span class="dot k-Builtin"></span>Built-in
    <span class="dot k-Plugin"></span>Plugin
    <span class="dot k-Unresolved"></span>Unresolved
    <span class="dot visited-dot"></span>Visited
  </div>
  <div id="cy"></div>
  <script src="${cytoscapeJs}"></script>
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
