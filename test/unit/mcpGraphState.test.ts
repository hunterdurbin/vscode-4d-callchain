import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { unpack } from "msgpackr";
import { Indexer, isTreeSitterReady } from "../../packages/core/dist";
import type { CallGraph, SymbolIndex } from "../../packages/core/dist";
import { GraphState } from "../../packages/mcp-server/dist/graphState.js";
import { initParser } from "../../packages/mcp-server/dist/parserInit.js";
import { resolveFixture } from "../helpers/fixture";

// The MCP server must parse with tree-sitter: a regex cold-rebuild persisted
// into the shared cache loses every chained-call (CsChainCall) edge and the
// extension would serve the degraded index. initParser() brings the WASM
// grammar up before GraphState constructs; GraphState then rebuilds over any
// regex-stamped cache and re-persists with treesitter provenance.

function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(sp, dp);
    else fs.copyFileSync(sp, dp);
  }
}

function mkTmpFixture(fixture: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "callchain-mcp-"));
  copyDir(fixture, tmp);
  return tmp;
}

function silentLogger() {
  return { info() {}, warn() {}, error() {} };
}

/** Exact cache path for a root — the fixture ships a committed cache for its
 *  own (different) root hash, so globbing .vscode would pick the wrong file. */
function cachePathFor(root: string): string {
  return new Indexer({ projectRoot: root, exclusions: [], logger: silentLogger() as any }).getCachePath();
}

describe("mcp-server GraphState parser bring-up", () => {
  const fixture = resolveFixture();
  if (!fixture) {
    it.skip("no fixture available", () => {});
    return;
  }
  const isMini = fixture.endsWith("mini-4d");

  let gs: GraphState | undefined;
  afterEach(() => {
    gs?.dispose();
    gs = undefined;
  });

  it("initParser() brings up tree-sitter via default resolution when no bundled wasm exists", async () => {
    // Dev layout: dist/mcp's sibling wasm pair is absent, so initParser falls
    // through to web-tree-sitter's own runtime wasm + @4d/parser-4d's grammar.
    await initParser();
    expect(isTreeSitterReady()).toBe(true);
  });

  it("rebuilds over a regex-stamped cache and re-persists with treesitter provenance", async () => {
    const root = mkTmpFixture(fixture);

    // Poisoned state: a regex-parsed index in the shared cache.
    const prev = process.env.FOURD_PARSER;
    process.env.FOURD_PARSER = "regex";
    try {
      const prime = new Indexer({ projectRoot: root, exclusions: [], logger: silentLogger() as any });
      await prime.load();
    } finally {
      if (prev === undefined) delete process.env.FOURD_PARSER;
      else process.env.FOURD_PARSER = prev;
    }
    expect((unpack(fs.readFileSync(cachePathFor(root))) as SymbolIndex).parserKind).toBe("regex");

    await initParser();
    gs = new GraphState({ projectRoot: root });
    await gs.init();

    // GraphState persists (persistMode "debounced" since tree-sitter is up);
    // the rebuild awaits the cache write before returning.
    const cache = unpack(fs.readFileSync(cachePathFor(root))) as SymbolIndex;
    expect(cache.parserKind).toBe("treesitter");

    if (isMini) {
      // The chain edge only a tree-sitter parse produces (same fixture as
      // test/indexer/cs-chain-resolution.test.ts).
      const idx = (gs.getGraph() as CallGraph as any).root as SymbolIndex;
      const chainEdge = idx.edges.find(
        (e) => e.toId === "ClassFunction:OrderHydrator.getNormalizedInvoiceFromDatastore" && e.resolved
      );
      expect(chainEdge).toBeTruthy();
    }
  });
});
