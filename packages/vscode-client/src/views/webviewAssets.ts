import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

// Webview js/css are copied into dist/webview/ by esbuild (the .vsix ships
// only dist/). In dev the source tree is present and always fresh, so prefer
// it; a packaged install has no src/ and uses the dist copies.

export interface WebviewAssets {
  /** Directories to allow via localResourceRoots. */
  roots: vscode.Uri[];
  /** Absolute path of a file inside the view's asset dir. */
  file(name: string): string;
}

export function resolveWebviewAssets(context: vscode.ExtensionContext, view: "trace"): WebviewAssets {
  const ext = context.extensionPath;
  const srcDir = path.join(ext, "src", "views", "traceView", "webview");
  const viewDir = fs.existsSync(srcDir) ? srcDir : path.join(ext, "dist", "webview", view);

  return {
    roots: [vscode.Uri.file(viewDir)],
    file: (name) => path.join(viewDir, name),
  };
}
