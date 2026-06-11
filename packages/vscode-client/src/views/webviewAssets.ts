import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

// Webview js/css and the cytoscape vendor bundle are copied into dist/webview/
// by esbuild (the .vsix ships only dist/). In dev the source tree is present
// and always fresh, so prefer it; a packaged install has no src/ or
// node_modules/ and uses the dist copies.

export interface WebviewAssets {
  /** Directories to allow via localResourceRoots. */
  roots: vscode.Uri[];
  /** Absolute path of a file inside the view's asset dir. */
  file(name: string): string;
  /** Absolute path of a vendor file (e.g. cytoscape.min.js). */
  vendor(name: string): string;
}

export function resolveWebviewAssets(context: vscode.ExtensionContext, view: "graph" | "trace"): WebviewAssets {
  const ext = context.extensionPath;
  const srcDir = path.join(
    ext, "src", "views", view === "graph" ? "graphView" : "traceView", "webview"
  );
  const viewDir = fs.existsSync(srcDir) ? srcDir : path.join(ext, "dist", "webview", view);

  // npm workspaces hoist cytoscape to the repo root, so resolve through node's
  // module lookup rather than assuming <ext>/node_modules.
  let vendorDir: string;
  try {
    vendorDir = path.dirname(require.resolve("cytoscape/dist/cytoscape.min.js", { paths: [ext] }));
  } catch {
    vendorDir = path.join(ext, "dist", "webview", "vendor");
  }

  return {
    roots: [vscode.Uri.file(viewDir), vscode.Uri.file(vendorDir)],
    file: (name) => path.join(viewDir, name),
    vendor: (name) => path.join(vendorDir, name),
  };
}
