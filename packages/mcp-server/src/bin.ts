#!/usr/bin/env node
import * as path from "path";
import { startServer, ServerOptions } from "./server.js";

/**
 * CLI entry point for the 4D call-graph MCP server.
 *
 * Usage:
 *   4d-callchain-mcp --project-root <path> [--cache-dir <path>]
 *
 * `--project-root` defaults to the current working directory. `--cache-dir`
 * overrides where the shared msgpack index is read from (defaults to
 * <project-root>/.vscode, matching the VS Code extension and LSP servers).
 */
function parseArgs(argv: string[]): ServerOptions {
  let projectRoot = process.cwd();
  let cacheDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project-root" || arg === "-p") projectRoot = argv[++i] ?? projectRoot;
    else if (arg.startsWith("--project-root=")) projectRoot = arg.slice("--project-root=".length);
    else if (arg === "--cache-dir") cacheDir = argv[++i];
    else if (arg.startsWith("--cache-dir=")) cacheDir = arg.slice("--cache-dir=".length);
  }
  return { projectRoot: path.resolve(projectRoot), cacheDir };
}

startServer(parseArgs(process.argv.slice(2))).catch((err) => {
  // stdout is reserved for the MCP protocol — log fatals to stderr only.
  console.error("[4d-callchain-mcp] fatal:", err);
  process.exit(1);
});
