import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { pack, unpack } from "msgpackr";
import { Indexer } from "../../packages/core/dist";
import type { SymbolIndex } from "../../packages/core/dist";
import { resolveFixture } from "../helpers/fixture";
import { initTreeSitter } from "../helpers/treeSitterIndex";

// The persisted msgpack cache is shared between the extension, the LSP server
// and the MCP server. Only tree-sitter-built indexes carry chained-call
// (CsChainCall) edges, so each index is stamped with the parser that built it
// and a tree-sitter-capable process must reject (and rebuild over) a cache
// built by the regex fallback — the bug was an MCP server cold-rebuilding
// with regex and silently poisoning the extension's cache.

function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(sp, dp);
    else fs.copyFileSync(sp, dp);
  }
}

function mkTmpFixture(): string {
  const fixture = resolveFixture();
  if (!fixture) throw new Error("Mini-fixture not available");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "callchain-provenance-"));
  copyDir(fixture, tmp);
  return tmp;
}

function silentLogger() {
  return { info() {}, warn() {}, error() {} };
}

const EXCLUSIONS = ["DerivedData", "Libraries", ".git", "node_modules"];

/** Counts "Scanning" lines (≡ full rebuilds) and provenance-rejection lines. */
function countingIndexer(root: string): {
  ix: Indexer;
  scans: () => number;
  provenanceRejections: () => number;
} {
  let scans = 0;
  let rejections = 0;
  const ix = new Indexer({
    projectRoot: root,
    exclusions: EXCLUSIONS,
    logger: {
      info: (m: string) => {
        if (m.includes("Scanning")) scans++;
        if (m.includes("tree-sitter is available")) rejections++;
      },
      warn: () => {},
      error: () => {}
    } as any
  });
  return { ix, scans: () => scans, provenanceRejections: () => rejections };
}

/** Run fn with the regex parser forced via env, restoring afterwards. The
 *  suite runs singleFork without isolation, so an earlier test file may have
 *  initialized tree-sitter — the env override is the only reliable way to
 *  exercise the regex side. */
async function withRegexParser<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.FOURD_PARSER;
  process.env.FOURD_PARSER = "regex";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.FOURD_PARSER;
    else process.env.FOURD_PARSER = prev;
  }
}

function readCache(ix: Indexer): SymbolIndex {
  return unpack(fs.readFileSync(ix.getCachePath())) as SymbolIndex;
}

describe("parser provenance stamp on the persisted index", () => {
  if (!resolveFixture()) {
    it.skip("no fixture available", () => {});
    return;
  }

  it("a regex rebuild stamps parserKind=regex; a tree-sitter process rejects that cache and re-stamps it", async () => {
    const root = mkTmpFixture();

    const ixRegex = new Indexer({ projectRoot: root, exclusions: EXCLUSIONS, logger: silentLogger() as any });
    await withRegexParser(() => ixRegex.load()); // cold → regex rebuild → persist
    expect(readCache(ixRegex).parserKind).toBe("regex");

    await initTreeSitter();
    const { ix, scans, provenanceRejections } = countingIndexer(root);
    await ix.load();
    expect(provenanceRejections()).toBe(1);
    expect(scans()).toBe(1); // regex cache rejected → full rebuild
    expect(readCache(ix).parserKind).toBe("treesitter");
  });

  it("a second tree-sitter process accepts the treesitter-stamped cache without rebuilding", async () => {
    const root = mkTmpFixture();
    await initTreeSitter();
    const prime = new Indexer({ projectRoot: root, exclusions: EXCLUSIONS, logger: silentLogger() as any });
    await prime.load();
    expect(readCache(prime).parserKind).toBe("treesitter");

    const { ix, scans } = countingIndexer(root);
    await ix.load();
    expect(scans()).toBe(0); // served from cache
  });

  it("a pre-stamp cache (parserKind missing) is regex provenance: TS process rebuilds, regex process loads it", async () => {
    const root = mkTmpFixture();
    await initTreeSitter();
    const prime = new Indexer({ projectRoot: root, exclusions: EXCLUSIONS, logger: silentLogger() as any });
    await prime.load();

    // Doctor the cache back to the pre-stamp format.
    const doctor = () => {
      const idx = readCache(prime);
      delete idx.parserKind;
      fs.writeFileSync(prime.getCachePath(), pack(idx));
    };

    doctor();
    const ts = countingIndexer(root);
    await ts.ix.load();
    expect(ts.scans()).toBe(1); // missing stamp → treated as regex → rebuild

    doctor();
    const rx = countingIndexer(root);
    await withRegexParser(() => rx.ix.load());
    expect(rx.scans()).toBe(0); // regex-only process keeps using it
  });
});
