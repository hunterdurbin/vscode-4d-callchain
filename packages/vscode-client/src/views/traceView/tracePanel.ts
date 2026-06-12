import * as vscode from "vscode";
import { CallGraph } from "@4d/core";
import { showCallSiteSnippets, traceHiddenKinds } from "../../config";
import {
  buildOverrideRows,
  buildTraceChildren,
  createTraceCaches,
  LEGACY_CLASSES_CATEGORIES,
  normalizeTraceOptions,
  TRACE_CATEGORIES,
  TraceOptions,
  TraceRow
} from "./traceData";
import { resolveWebviewAssets } from "../webviewAssets";

const EXPAND_BUDGET = 1000; // rows per single lazy expand
const DEEP_BUDGET = 5000; // rows per expand-to-depth rebuild
const OPTIONS_KEY = "callchain.trace.options";

interface NodeEntry {
  row: TraceRow;
  ancestors: Set<string>; // chain root → … → this row's callee (inclusive)
  receiverClass?: string; // concrete class pinned for this row's subtree
}

export class TracePanel {
  private static current: TracePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private rootId: string;
  private readonly nodes = new Map<string, NodeEntry>();
  private idCounter = 0;
  // Defaults saved by the "Save as default" button (workspaceState); the
  // config keys only seed the very first run.
  private savedOptions: TraceOptions;

  static show(context: vscode.ExtensionContext, graph: CallGraph, rootId: string): TracePanel {
    if (this.current) {
      this.current.panel.reveal();
      this.current.graph = graph;
      this.current.setRoot(rootId);
      return this.current;
    }
    const assets = resolveWebviewAssets(context, "trace");
    const panel = vscode.window.createWebviewPanel(
      "callchainTrace",
      "4D Method Trace",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: assets.roots
      }
    );
    this.current = new TracePanel(panel, context, graph, rootId);
    // Lock the panel's editor group so row clicks open files in the other
    // group instead of replacing the trace. The panel was just created
    // active, so the command targets its group.
    void vscode.commands.executeCommand("workbench.action.lockEditorGroup");
    return this.current;
  }

  /** Re-render an open panel against a fresh graph after a reindex. */
  static refreshIfOpen(graph: CallGraph): void {
    const p = this.current;
    if (!p) return;
    p.graph = graph;
    p.postRoot();
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private graph: CallGraph,
    rootId: string
  ) {
    this.panel = panel;
    this.rootId = rootId;
    this.savedOptions = normalizeTraceOptions(context.workspaceState.get(OPTIONS_KEY), {
      // Expand the pre-split "classes" umbrella value to the fine-grained ids.
      hiddenKinds: traceHiddenKinds().flatMap((id) => (id === "classes" ? LEGACY_CLASSES_CATEGORIES : [id])),
      showSnippets: showCallSiteSnippets()
    });
    this.panel.webview.html = this.renderHtml();
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg), undefined, this.disposables);
  }

  private setRoot(rootId: string): void {
    this.rootId = rootId;
    this.postRoot();
  }

  private nextId = (): string => String(this.idCounter++);

  /** Register a freshly built subtree so later messages can refer to nodeIds. */
  private registerRows(rows: TraceRow[], parentAncestors: ReadonlySet<string>): void {
    for (const row of rows) {
      const ancestors = new Set([...parentAncestors, row.calleeId]);
      this.nodes.set(row.nodeId, { row, ancestors, receiverClass: row.receiverClass });
      if (row.children) this.registerRows(row.children, ancestors);
      // "May run" alternatives expand as their own branches: their own callee
      // joins the parent's ancestor chain, and their class is the pin.
      if (row.alternatives) this.registerRows(row.alternatives, parentAncestors);
    }
  }

  private postRoot(depth = 1): void {
    const root = this.graph.symbol(this.rootId);
    if (!root) {
      this.panel.webview.postMessage({ type: "root", payload: { root: null, children: [], options: this.options(false) } });
      return;
    }
    this.nodes.clear();
    this.idCounter = 0;
    const budget = { left: depth > 1 ? DEEP_BUDGET : EXPAND_BUDGET };
    const ancestors = new Set([this.rootId]);
    const children = buildTraceChildren(
      this.graph,
      this.rootId,
      ancestors,
      depth,
      this.nextId,
      budget,
      root.ownerClass,
      createTraceCaches()
    );
    this.registerRows(children, ancestors);
    this.panel.title = `4D Trace — ${root.ownerClass ? `${root.ownerClass}.` : ""}${root.name}`;
    this.panel.webview.postMessage({
      type: "root",
      payload: {
        root: {
          symbolId: root.id,
          name: root.name,
          kind: root.kind,
          ownerClass: root.ownerClass,
          childCount: this.graph.callees(root.id).length
        },
        children,
        options: this.options(budget.left <= 0)
      }
    });
  }

  private options(truncated: boolean) {
    return {
      hiddenCategories: this.savedOptions.hiddenKinds,
      showSnippets: this.savedOptions.showSnippets,
      expandDepth: this.savedOptions.expandDepth,
      categories: TRACE_CATEGORIES,
      truncated
    };
  }

  private handleMessage(msg: { type: string; payload?: any }): void {
    switch (msg.type) {
      case "ready":
        // A saved depth > 1 pre-expands on open (DEEP_BUDGET bounds the cost).
        this.postRoot(this.savedOptions.expandDepth);
        break;
      case "saveDefaults": {
        const next = normalizeTraceOptions(msg.payload, {
          hiddenKinds: this.savedOptions.hiddenKinds,
          showSnippets: this.savedOptions.showSnippets
        });
        this.savedOptions = next;
        void this.context.workspaceState.update(OPTIONS_KEY, next);
        this.panel.webview.postMessage({ type: "defaultsSaved" });
        break;
      }
      case "expand": {
        const entry = this.nodes.get(String(msg.payload?.nodeId));
        if (!entry || entry.row.recursive) return;
        const budget = { left: EXPAND_BUDGET };
        const children = buildTraceChildren(
          this.graph,
          entry.row.calleeId,
          entry.ancestors,
          1,
          this.nextId,
          budget,
          entry.receiverClass
        );
        this.registerRows(children, entry.ancestors);
        this.panel.webview.postMessage({
          type: "children",
          payload: { nodeId: entry.row.nodeId, children, truncated: budget.left <= 0 }
        });
        break;
      }
      case "expandToDepth": {
        const d = Number(msg.payload?.depth);
        if (Number.isFinite(d) && d >= 1 && d <= 6) this.postRoot(d);
        break;
      }
      case "openCallSite": {
        const entry = this.nodes.get(String(msg.payload?.nodeId));
        if (!entry) return;
        const { fromId, line, column, endColumn } = entry.row;
        vscode.commands.executeCommand("callchain.openSymbol", fromId, line, column, endColumn);
        break;
      }
      case "openDefinition": {
        const entry = this.nodes.get(String(msg.payload?.nodeId));
        if (!entry) return;
        vscode.commands.executeCommand("callchain.openSymbol", entry.row.calleeId);
        break;
      }
      case "setRoot":
        if (typeof msg.payload?.symbolId === "string") this.setRoot(msg.payload.symbolId);
        break;
      case "showOverrides": {
        const entry = this.nodes.get(String(msg.payload?.nodeId));
        if (!entry) return;
        // Overrides register against the parent's chain, like in-tree
        // alternatives (each is a sibling possibility, not a descendant).
        const parentAncestors = new Set([...entry.ancestors].filter((id) => id !== entry.row.calleeId));
        const rows = buildOverrideRows(this.graph, entry.row, parentAncestors, this.nextId);
        this.registerRows(rows, parentAncestors);
        this.panel.webview.postMessage({
          type: "overrides",
          payload: { nodeId: entry.row.nodeId, rows }
        });
        break;
      }
      case "openSymbolById":
        if (typeof msg.payload?.symbolId === "string") {
          vscode.commands.executeCommand("callchain.openSymbol", msg.payload.symbolId);
        }
        break;
      case "copy":
        if (typeof msg.payload?.text === "string") void vscode.env.clipboard.writeText(msg.payload.text);
        break;
    }
  }

  private renderHtml(): string {
    const assets = resolveWebviewAssets(this.context, "trace");
    const indexCss = this.toWebUri(assets.file("trace.css"));
    const indexJs = this.toWebUri(assets.file("trace.js"));
    const csp = `default-src 'none'; img-src ${this.panel.webview.cspSource} https:; script-src ${this.panel.webview.cspSource}; style-src ${this.panel.webview.cspSource} 'unsafe-inline';`;
    return /* html */ `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${indexCss}">
  <title>4D Method Trace</title>
</head>
<body>
  <div id="toolbar">
    <div class="dropdown">
      <button id="kindsBtn">Kinds ▾</button>
      <div id="kindsMenu" class="menu" hidden></div>
    </div>
    <input id="filter" type="search" placeholder="Filter by name…">
    <label><input id="snippets" type="checkbox"> Snippets</label>
    <label>Expand to
      <select id="depthSel">
        <option>1</option><option>2</option><option>3</option><option>4</option><option>5</option><option>6</option>
      </select>
      <button id="expandBtn">Go</button>
    </label>
    <button id="saveDefaults" title="Save the current Kinds, Snippets and Expand-to settings as this workspace's default">Save as default</button>
    <span id="truncated" hidden>⚠ truncated</span>
    <span id="stats"></span>
  </div>
  <div id="tree"></div>
  <div id="ctxMenu" class="menu ctx" hidden></div>
  <script src="${indexJs}"></script>
</body>
</html>`;
  }

  private toWebUri(absPath: string): string {
    return this.panel.webview.asWebviewUri(vscode.Uri.file(absPath)).toString();
  }

  dispose(): void {
    TracePanel.current = undefined;
    for (const d of this.disposables) d.dispose();
  }
}
