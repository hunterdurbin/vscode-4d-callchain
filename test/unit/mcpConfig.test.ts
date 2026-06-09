import { describe, expect, it } from "vitest";
import {
  buildEntry,
  mergeIntoConfig,
  renderSnippet,
  serverNameFor,
  targetById
} from "../../packages/vscode-client/src/mcp/mcpConfig";

const BIN = "/abs/packages/mcp-server/dist/bin.js";
const ROOT = "/home/me/projects/My 4D App";

describe("mcpConfig", () => {
  it("buildEntry produces a node stdio invocation; VS Code gets type:stdio", () => {
    const claude = buildEntry(BIN, ROOT, targetById("claude-project"));
    expect(claude).toEqual({ command: "node", args: [BIN, "--project-root", ROOT] });
    expect(claude.type).toBeUndefined();

    const code = buildEntry(BIN, ROOT, targetById("vscode"));
    expect(code.type).toBe("stdio");
    expect(code.args).toEqual([BIN, "--project-root", ROOT]);
  });

  it("uses the right root key per target", () => {
    expect(targetById("claude-project").rootKey).toBe("mcpServers");
    expect(targetById("cursor").rootKey).toBe("mcpServers");
    expect(targetById("vscode").rootKey).toBe("servers");
  });

  it("server name is stable per project, qualified for the shared global file", () => {
    expect(serverNameFor(targetById("claude-project"), ROOT)).toBe("4d-callchain");
    expect(serverNameFor(targetById("cursor"), ROOT)).toBe("4d-callchain");
    expect(serverNameFor(targetById("claude-global"), ROOT)).toBe("4d-callchain-my-4d-app");
  });

  it("computes config file paths", () => {
    const home = "/home/me";
    expect(targetById("claude-project").filePath(ROOT, home)).toBe(`${ROOT}/.mcp.json`);
    expect(targetById("claude-global").filePath(ROOT, home)).toBe(`${home}/.claude.json`);
    expect(targetById("cursor").filePath(ROOT, home)).toBe(`${ROOT}/.cursor/mcp.json`);
    expect(targetById("vscode").filePath(ROOT, home)).toBe(`${ROOT}/.vscode/mcp.json`);
  });

  it("mergeIntoConfig adds the server without dropping existing ones", () => {
    const target = targetById("claude-project");
    const existing = {
      mcpServers: { "some-other": { command: "x", args: [] } },
      unrelatedTopKey: true
    };
    const merged = mergeIntoConfig(existing, target, "4d-callchain", buildEntry(BIN, ROOT, target));
    const servers = merged.mcpServers as Record<string, unknown>;
    expect(Object.keys(servers).sort()).toEqual(["4d-callchain", "some-other"]);
    expect(merged.unrelatedTopKey).toBe(true);
    // input not mutated
    expect(Object.keys(existing.mcpServers)).toEqual(["some-other"]);
  });

  it("merges into the VS Code 'servers' key and tolerates an empty config", () => {
    const target = targetById("vscode");
    const merged = mergeIntoConfig(undefined, target, "4d-callchain", buildEntry(BIN, ROOT, target));
    expect(merged.mcpServers).toBeUndefined();
    expect((merged.servers as any)["4d-callchain"].type).toBe("stdio");
  });

  it("renderSnippet emits valid JSON nested under the root key", () => {
    const target = targetById("cursor");
    const snippet = renderSnippet(target, "4d-callchain", buildEntry(BIN, ROOT, target));
    const parsed = JSON.parse(snippet);
    expect(parsed.mcpServers["4d-callchain"].command).toBe("node");
  });
});
