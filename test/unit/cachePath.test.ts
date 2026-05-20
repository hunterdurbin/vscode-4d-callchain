import { describe, expect, it } from "vitest";
import * as path from "path";
import { Indexer } from "../../packages/core/dist";

function makeIndexer(projectRoot: string, cacheDir?: string): Indexer {
  return new Indexer({
    projectRoot,
    cacheDir,
    exclusions: [],
    logger: { info() {}, warn() {}, error() {} } as any
  });
}

describe("Indexer.getCachePath()", () => {
  it("returns a hashed filename under <projectRoot>/.vscode by default", () => {
    const p = makeIndexer("/proj/a").getCachePath();
    expect(p.startsWith(path.join("/proj/a", ".vscode") + path.sep)).toBe(true);
    expect(/callchain-index-[0-9a-f]{12}\.msgpack$/.test(p)).toBe(true);
  });

  it("is stable for the same project root across instances", () => {
    const a1 = makeIndexer("/proj/a").getCachePath();
    const a2 = makeIndexer("/proj/a").getCachePath();
    expect(a1).toBe(a2);
  });

  it("differs for different project roots so caches co-exist", () => {
    const a = makeIndexer("/proj/a").getCachePath();
    const b = makeIndexer("/proj/b").getCachePath();
    expect(a).not.toBe(b);
  });

  it("canonicalizes via path.resolve so trailing slashes don't fork the hash", () => {
    const noSlash = makeIndexer("/proj/a").getCachePath();
    const withSlash = makeIndexer("/proj/a/").getCachePath();
    expect(noSlash).toBe(withSlash);
  });

  it("honors the cacheDir override while still hashing the filename", () => {
    const p = makeIndexer("/proj/a", "/tmp/scratch").getCachePath();
    expect(p.startsWith("/tmp/scratch" + path.sep)).toBe(true);
    expect(/callchain-index-[0-9a-f]{12}\.msgpack$/.test(p)).toBe(true);
  });
});
