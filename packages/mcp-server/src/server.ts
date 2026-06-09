import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { consoleLogger } from "@4d/core";
import { GraphState } from "./graphState.js";
import { registerTools } from "./tools.js";

export interface ServerOptions {
  /** Absolute path to the 4D project root (the folder containing Project/). */
  projectRoot: string;
  /** Override for the index cache directory. Defaults to <projectRoot>/.vscode. */
  cacheDir?: string;
}

/**
 * Boot the MCP server: load the shared call-graph index, register the query
 * tools, and serve over stdio. Tools are registered in Phase 4.
 */
export async function startServer(opts: ServerOptions): Promise<void> {
  const state = new GraphState(opts);
  await state.init();
  consoleLogger.info(
    `[4d-callchain-mcp] ready — ${state.getGraph().allSymbols().length} symbols from ${opts.projectRoot}`
  );

  const server = new McpServer({
    name: "4d-callchain",
    version: "0.1.16"
  });
  registerTools(server, state);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => {
    state.dispose();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
