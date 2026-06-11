import * as vscode from "vscode";
import { projectRootSetting } from "../config";

/**
 * Resolve the 4D project root: the explicit `callchain.index.projectRoot`
 * setting when present, otherwise the first workspace folder.
 */
export function resolveProjectRoot(): string | undefined {
  const configured = projectRootSetting();
  if (configured) return configured;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return folders[0].uri.fsPath;
}
