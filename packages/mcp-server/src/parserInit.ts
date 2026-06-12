import * as fs from "fs";
import * as path from "path";
import { consoleLogger, initTreeSitterParser } from "@4d/core";

/**
 * Bring up the tree-sitter parser before GraphState constructs, mirroring
 * the extension's initParser (vscode-client/src/extension.ts). Without it,
 * a cold rebuild here would fall back to the regex parser — which can't
 * emit chained-call (CsChainCall) edges — and persist that degraded index
 * into the cache shared with the extension.
 *
 * In the packaged .vsix this bundle lives at dist/mcp/bin.js with the two
 * wasm assets one level up at dist/ — point the loader at them explicitly,
 * since package-relative resolution doesn't survive bundling. Running from
 * source (tsc output) they're absent, so we fall through to the default
 * resolution: web-tree-sitter finds its own runtime wasm and the grammar
 * comes from the lazily-required @4d/parser-4d workspace package (kept
 * external in esbuild.js precisely so this dev path keeps working).
 * Failures fall back silently to the regex parser (logged to stderr).
 */
export async function initParser(): Promise<void> {
  try {
    const runtimeWasm = path.join(__dirname, "..", "tree-sitter.wasm");
    const languageWasm = path.join(__dirname, "..", "tree-sitter-fourd.wasm");
    const initOpts: { runtimeWasmPath?: string; languageWasmPath?: string } = {};
    if (fs.existsSync(runtimeWasm)) initOpts.runtimeWasmPath = runtimeWasm;
    if (fs.existsSync(languageWasm)) initOpts.languageWasmPath = languageWasm;
    await initTreeSitterParser(initOpts);
  } catch (e) {
    consoleLogger.warn(
      `[4d-callchain-mcp] Tree-sitter init failed; using regex parser: ${(e as Error).message}`
    );
  }
}
