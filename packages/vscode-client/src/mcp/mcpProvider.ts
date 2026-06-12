import * as vscode from "vscode";
import * as config from "../config";
import { resolveBinPath } from "./setupMcp";

/**
 * Offers the bundled MCP server to VS Code's built-in MCP support via the
 * official `vscode.lm.registerMcpServerDefinitionProvider` API.
 *
 * Deliberately conservative on every axis:
 *  - Feature-detected: the API exists in VS Code ≥ 1.101. On older hosts and
 *    forks (Cursor, Windsurf) this module is a silent no-op — `engines` stays
 *    at ^1.85.0 and those users keep the clipboard-snippet command instead.
 *  - Opt-in: `callchain.mcp.enabled` defaults to false; until the user flips
 *    it the provider returns nothing.
 *  - Trust-gated: no server definition is offered in untrusted workspaces.
 *  - Registration only: even when enabled, VS Code lists the server and asks
 *    the user before ever starting it. The extension itself never spawns it
 *    and never writes any agent config file.
 */

/** Structural shim for the 1.101+ API so we can compile against 1.85 types. */
interface McpStdioServerDefinitionLike {
  label: string;
  command: string;
  args: string[];
  cwd?: vscode.Uri;
}
interface McpStdioServerDefinitionCtor {
  new (label: string, command: string, args?: string[]): McpStdioServerDefinitionLike;
}
interface McpServerDefinitionProviderLike {
  onDidChangeMcpServerDefinitions: vscode.Event<void>;
  provideMcpServerDefinitions(token: vscode.CancellationToken): vscode.ProviderResult<McpStdioServerDefinitionLike[]>;
}
type RegisterFn = (id: string, provider: McpServerDefinitionProviderLike) => vscode.Disposable;

/** Must match the `mcpServerDefinitionProviders` id contributed in package.json. */
const PROVIDER_ID = "callchain.mcpServers";

export function registerMcpProvider(
  context: vscode.ExtensionContext,
  resolveProjectRoot: () => string | undefined,
  output: vscode.OutputChannel
): void {
  const register = (vscode.lm as { registerMcpServerDefinitionProvider?: RegisterFn } | undefined)
    ?.registerMcpServerDefinitionProvider;
  const StdioDefinition = (vscode as unknown as { McpStdioServerDefinition?: McpStdioServerDefinitionCtor })
    .McpStdioServerDefinition;
  if (typeof register !== "function" || typeof StdioDefinition !== "function") {
    output.appendLine("[MCP] Host has no MCP provider API; use 'Copy MCP server config' instead.");
    return;
  }

  const didChange = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    didChange,
    register(PROVIDER_ID, {
      onDidChangeMcpServerDefinitions: didChange.event,
      provideMcpServerDefinitions: () => {
        if (!config.mcpEnabled()) return [];
        if (!vscode.workspace.isTrusted) return [];
        const projectRoot = resolveProjectRoot();
        if (!projectRoot) return [];
        const binPath = resolveBinPath(context);
        if (!binPath) {
          output.appendLine("[MCP] callchain.mcp.enabled is on but no server bin found; set callchain.mcp.binPath.");
          return [];
        }
        // Same launch shape as the clipboard snippets (mcpConfig.buildEntry).
        const def = new StdioDefinition("4D Call Chain", "node", [binPath, "--project-root", projectRoot]);
        def.cwd = vscode.Uri.file(projectRoot);
        return [def];
      },
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (config.affectsAny(e, "mcp.enabled", "mcp.binPath")) didChange.fire();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => didChange.fire())
  );
}
