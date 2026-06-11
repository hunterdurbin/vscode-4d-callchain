import * as vscode from "vscode";
import { mcpBinPath } from "../config";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildEntry, MCP_TARGETS, renderSnippet, serverNameFor } from "./mcpConfig";

/**
 * Locate the MCP server's `dist/bin.js`. Resolution order:
 *   1. the `callchain.mcp.binPath` setting (escape hatch for packaged use)
 *   2. `require.resolve` via the workspace symlink (works when running from source)
 *   3. an extension-relative node_modules path
 * Returns undefined if none point at an existing file.
 */
export function resolveBinPath(context: vscode.ExtensionContext): string | undefined {
  const configured = mcpBinPath();
  if (configured) return configured;

  try {
    return require.resolve("@4d/mcp-server/dist/bin.js");
  } catch {
    /* not resolvable when packaged / not installed */
  }

  const candidate = path.join(context.extensionPath, "node_modules", "@4d", "mcp-server", "dist", "bin.js");
  return fs.existsSync(candidate) ? candidate : undefined;
}

/**
 * Register `callchain.setupMcp` — generates the MCP config for the current 4D
 * project and copies it to the clipboard, annotated with the file each snippet
 * belongs in. The extension never writes agent config files itself; pasting is
 * deliberately left to the user.
 */
export function registerMcpSetup(
  context: vscode.ExtensionContext,
  resolveProjectRoot: () => string | undefined
): vscode.Disposable {
  return vscode.commands.registerCommand("callchain.setupMcp", async () => {
    const projectRoot = resolveProjectRoot();
    if (!projectRoot) {
      vscode.window.showInformationMessage("4D Call Chain: no project root — open a 4D workspace first.");
      return;
    }

    let binPath = resolveBinPath(context);
    if (!binPath) {
      const choice = await vscode.window.showWarningMessage(
        "Couldn't locate the 4D Call Chain MCP server bin. Set 'callchain.mcp.binPath', or copy a config with a placeholder path.",
        "Copy with placeholder",
        "Open settings"
      );
      if (choice === "Open settings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "callchain.mcp.binPath");
        return;
      }
      if (choice !== "Copy with placeholder") return;
      binPath = "/absolute/path/to/packages/mcp-server/dist/bin.js";
    }

    const picked = await vscode.window.showQuickPick(
      MCP_TARGETS.map((t) => ({ label: t.label, detail: t.detail, picked: t.id === "claude-project", target: t })),
      { canPickMany: true, title: "Copy MCP server config — choose agent target(s)", placeHolder: "Select one or more" }
    );
    if (!picked || picked.length === 0) return;
    const targets = picked.map((p) => p.target);

    const text = targets
      .map(
        (t) =>
          `// ${t.label} — paste into ${t.filePath(projectRoot, os.homedir())}\n` +
          renderSnippet(t, serverNameFor(t, projectRoot), buildEntry(binPath!, projectRoot, t))
      )
      .join("\n\n");
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(
      `4D Call Chain: copied MCP config for ${targets.length} target(s) to clipboard. Paste into the file(s) noted in the snippet, then restart your agent.`
    );
  });
}
