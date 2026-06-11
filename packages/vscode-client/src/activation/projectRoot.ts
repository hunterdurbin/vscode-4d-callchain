import * as vscode from "vscode";

/**
 * Resolve the 4D project root: the explicit `callchain.projectRoot` setting
 * when present, otherwise the first workspace folder.
 */
export function resolveProjectRoot(): string | undefined {
  const cfg = vscode.workspace.getConfiguration("callchain").get<string>("projectRoot", "");
  if (cfg) return cfg;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return folders[0].uri.fsPath;
}
