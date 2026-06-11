import * as vscode from "vscode";
import { mcpBinPath } from "../config";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildEntry,
  McpTarget,
  MCP_TARGETS,
  mergeIntoConfig,
  renderSnippet,
  serverNameFor
} from "./mcpConfig";

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

/** Read + parse a JSON config file, tolerating a missing or empty file. */
function readJsonObject(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  const text = fs.readFileSync(filePath, "utf8").trim();
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

function writeTarget(
  target: McpTarget,
  projectRoot: string,
  binPath: string
): { file: string } {
  const file = target.filePath(projectRoot, os.homedir());
  const existing = readJsonObject(file);
  const name = serverNameFor(target, projectRoot);
  const merged = mergeIntoConfig(existing, target, name, buildEntry(binPath, projectRoot, target));

  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + "\n", "utf8");
  return { file };
}

/**
 * Register `callchain.setupMcp` — generates the MCP config for the current 4D
 * project and either writes/merges it into the chosen agent config files or
 * copies the JSON to the clipboard.
 */
export function registerMcpSetup(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
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
        "Couldn't locate the 4D Call Chain MCP server bin. Set 'callchain.mcpServer.binPath', or copy a config with a placeholder path.",
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

    // 1. Pick targets.
    const picked = await vscode.window.showQuickPick(
      MCP_TARGETS.map((t) => ({ label: t.label, detail: t.detail, picked: t.id === "claude-project", target: t })),
      { canPickMany: true, title: "Set up MCP server — choose agent target(s)", placeHolder: "Select one or more" }
    );
    if (!picked || picked.length === 0) return;
    const targets = picked.map((p) => p.target);

    // 2. Pick action.
    const WRITE = "Write & merge into file(s)";
    const COPY = "Copy JSON to clipboard";
    const action = await vscode.window.showQuickPick([WRITE, COPY], {
      title: "Set up MCP server — action",
      placeHolder: "Write the config files, or copy the JSON to paste yourself"
    });
    if (!action) return;

    if (action === COPY) {
      const text =
        targets.length === 1
          ? renderSnippet(targets[0], serverNameFor(targets[0], projectRoot), buildEntry(binPath, projectRoot, targets[0]))
          : targets
              .map(
                (t) =>
                  `// ${t.label} — ${t.filePath(projectRoot, os.homedir())}\n` +
                  renderSnippet(t, serverNameFor(t, projectRoot), buildEntry(binPath!, projectRoot, t))
              )
              .join("\n\n");
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage(`4D Call Chain: copied MCP config for ${targets.length} target(s) to clipboard.`);
      return;
    }

    // Write path. Confirm before touching a shared user-global file.
    if (targets.some((t) => t.global)) {
      const ok = await vscode.window.showWarningMessage(
        "This will modify your global ~/.claude.json (a backup .bak is written first). Continue?",
        { modal: true },
        "Write"
      );
      if (ok !== "Write") return;
    }

    const written: string[] = [];
    for (const t of targets) {
      try {
        const { file } = writeTarget(t, projectRoot, binPath);
        written.push(file);
        output.appendLine(`[MCP] wrote ${file}`);
      } catch (err) {
        output.appendLine(`[MCP] failed writing ${t.label}: ${err}`);
        vscode.window.showErrorMessage(`4D Call Chain: failed to write ${t.label}: ${err}`);
      }
    }
    if (written.length === 0) return;

    const reveal = "Reveal";
    const choice = await vscode.window.showInformationMessage(
      `4D Call Chain: wrote MCP config to ${written.length} file(s). Restart your agent to pick it up.`,
      reveal
    );
    if (choice === reveal) {
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(written[0]));
    }
  });
}
