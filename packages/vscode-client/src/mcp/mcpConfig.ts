import * as path from "path";

/**
 * Pure (no `vscode`) helpers for generating MCP server configuration for the
 * various AI-agent targets. Kept editor-free so it can be unit-tested directly.
 */

export type McpTargetId = "claude-project" | "claude-global" | "cursor" | "vscode";

export interface McpTarget {
  id: McpTargetId;
  label: string;
  detail: string;
  /** Top-level object key the server map lives under. VS Code uses "servers". */
  rootKey: "mcpServers" | "servers";
  /** VS Code's `.vscode/mcp.json` entries require a `"type": "stdio"` field. */
  needsType: boolean;
  /** Absolute path of the config file the user should paste the snippet into. */
  filePath(projectRoot: string, home: string): string;
  /** Whether the file is a shared user-global file (affects server naming). */
  global: boolean;
}

/** A single stdio MCP server entry. */
export interface McpServerEntry {
  type?: "stdio";
  command: string;
  args: string[];
}

export const MCP_TARGETS: McpTarget[] = [
  {
    id: "claude-project",
    label: "Claude Code (project)",
    detail: ".mcp.json at the project root — shared with the repo",
    rootKey: "mcpServers",
    needsType: false,
    global: false,
    filePath: (root) => path.join(root, ".mcp.json")
  },
  {
    id: "claude-global",
    label: "Claude Code (global)",
    detail: "~/.claude.json — per-project server key so multiple projects coexist",
    rootKey: "mcpServers",
    needsType: false,
    global: true,
    filePath: (_root, home) => path.join(home, ".claude.json")
  },
  {
    id: "cursor",
    label: "Cursor",
    detail: ".cursor/mcp.json in the project",
    rootKey: "mcpServers",
    needsType: false,
    global: false,
    filePath: (root) => path.join(root, ".cursor", "mcp.json")
  },
  {
    id: "vscode",
    label: "VS Code / Copilot",
    detail: ".vscode/mcp.json (uses \"servers\" + type: stdio) — or skip the file and enable callchain.mcp.enabled",
    rootKey: "servers",
    needsType: true,
    global: false,
    filePath: (root) => path.join(root, ".vscode", "mcp.json")
  }
];

export function targetById(id: McpTargetId): McpTarget {
  const t = MCP_TARGETS.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown MCP target: ${id}`);
  return t;
}

/**
 * Server key under the root map. Project-scoped files use a stable
 * "4d-callchain"; the shared global file qualifies it with the project's
 * folder name so several projects can register side by side.
 */
export function serverNameFor(target: McpTarget, projectRoot: string): string {
  if (!target.global) return "4d-callchain";
  const base = path.basename(projectRoot).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base ? `4d-callchain-${base}` : "4d-callchain";
}

/** Build the stdio server entry that launches the MCP server for a project. */
export function buildEntry(binPath: string, projectRoot: string, target: McpTarget): McpServerEntry {
  const entry: McpServerEntry = {
    command: "node",
    args: [binPath, "--project-root", projectRoot]
  };
  if (target.needsType) entry.type = "stdio";
  return entry;
}

/** Pretty-printed JSON snippet for one target (for clipboard / display). */
export function renderSnippet(target: McpTarget, name: string, entry: McpServerEntry): string {
  return JSON.stringify({ [target.rootKey]: { [name]: entry } }, null, 2);
}
