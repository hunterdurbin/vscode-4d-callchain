import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Indexer } from "../../packages/core/dist";
import type { CallEdge, SymbolIndex, SymbolRecord } from "../../packages/core/dist";
import { resolveFixture } from "../helpers/fixture";

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "callchain-warm-"));
  copyDir(fixture, tmp);
  return tmp;
}

function silentLogger() {
  return { info() {}, warn() {}, error() {} };
}

const EXCLUSIONS = ["DerivedData", "Libraries", ".git", "node_modules"];

/** Indexer that counts "Scanning" lines (≡ full rebuilds) and drift warnings. */
function countingIndexer(root: string): { ix: Indexer; scans: () => number; drift: () => number } {
  let scans = 0;
  let drift = 0;
  const ix = new Indexer({
    projectRoot: root,
    exclusions: EXCLUSIONS,
    logger: {
      info: (m: string) => { if (m.includes("Scanning")) scans++; },
      warn: (m: string) => { if (m.includes("drift")) drift++; },
      error: () => {}
    } as any
  });
  return { ix, scans: () => scans, drift: () => drift };
}

/** Build the on-disk cache so a follow-up Indexer load()s instead of rebuilding. */
async function primeCache(root: string): Promise<void> {
  const ix = new Indexer({ projectRoot: root, exclusions: EXCLUSIONS, logger: silentLogger() as any });
  await ix.load(); // cold → rebuild → persist (rebuild awaits the cache write)
}

async function freshIndex(root: string): Promise<SymbolIndex> {
  const ix = new Indexer({
    projectRoot: root,
    exclusions: EXCLUSIONS,
    logger: silentLogger() as any,
    cacheDir: path.join(root, ".vscode-fresh")
  });
  const g = await ix.load();
  return (g as any).root as SymbolIndex;
}

function sortSymbols(idx: SymbolIndex): Pick<SymbolRecord, "id" | "kind" | "name">[] {
  return idx.symbols
    .map((s) => ({ id: s.id, kind: s.kind, name: s.name }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function sortEdges(idx: SymbolIndex): Pick<CallEdge, "fromId" | "toId" | "line" | "callKind">[] {
  return idx.edges
    .map((e) => ({ fromId: e.fromId, toId: e.toId, line: e.line, callKind: e.callKind }))
    .sort((a, b) =>
      a.fromId.localeCompare(b.fromId) ||
      a.toId.localeCompare(b.toId) ||
      a.line - b.line ||
      a.callKind.localeCompare(b.callKind)
    );
}

describe("background warm pass after cache load", () => {
  if (!resolveFixture()) {
    it.skip("no fixture available", () => {});
    return;
  }

  it("load → warm → patch runs incrementally (no rebuild) and matches a fresh rebuild", async () => {
    const root = mkTmpFixture();
    await primeCache(root);

    const { ix, scans } = countingIndexer(root);
    await ix.load();
    expect(scans()).toBe(0); // served from cache

    await ix.warm();
    expect(scans()).toBe(0); // warm is not a rebuild

    // First change after startup — previously this always paid a rebuild.
    const target = path.join(root, "Project", "Sources", "Methods", "MyLength.4dm");
    const original = fs.readFileSync(target, "utf8");
    fs.writeFileSync(target, original.replace("Length($s)+1", "Length($s)+2"));
    await ix.patchFile(target);

    expect(scans()).toBe(0);
    expect(ix.getLastPatchStats()?.files).toBe(1); // incremental path ran

    const patched = (ix.getGraph() as any).root as SymbolIndex;
    const fresh = await freshIndex(root);
    expect(sortSymbols(patched)).toEqual(sortSymbols(fresh));
    expect(sortEdges(patched)).toEqual(sortEdges(fresh));
  });

  it("getParsedFile() serves parses after warm (lint rules depend on this)", async () => {
    const root = mkTmpFixture();
    await primeCache(root);

    const { ix } = countingIndexer(root);
    await ix.load();
    const target = path.join(root, "Project", "Sources", "Methods", "MyLength.4dm");
    expect(ix.getParsedFile(target)).toBeUndefined(); // cache-only load has no parses

    await ix.warm();
    expect(ix.getParsedFile(target)).toBeTruthy();
  });

  it("a patch issued mid-warm awaits the warm and still patches incrementally", async () => {
    const root = mkTmpFixture();
    await primeCache(root);

    const { ix, scans } = countingIndexer(root);
    await ix.load();

    const target = path.join(root, "Project", "Sources", "Methods", "MyLength.4dm");
    const original = fs.readFileSync(target, "utf8");
    fs.writeFileSync(target, original.replace("Length($s)+1", "Length($s)+2"));

    // Fire-and-forget warm (as the hosts do), then patch immediately —
    // before the warm has finished building PatchState.
    const warmP = ix.warm();
    const patchP = ix.patchFile(target);
    await Promise.all([warmP, patchP]);

    expect(scans()).toBe(0);
    expect(ix.getLastPatchStats()?.files).toBe(1);

    const patched = (ix.getGraph() as any).root as SymbolIndex;
    const fresh = await freshIndex(root);
    expect(sortSymbols(patched)).toEqual(sortSymbols(fresh));
    expect(sortEdges(patched)).toEqual(sortEdges(fresh));
  });

  it("a rebuild starting mid-warm wins; the warm aborts without double-populating", async () => {
    const root = mkTmpFixture();
    await primeCache(root);

    const { ix, scans } = countingIndexer(root);
    await ix.load();

    const warmP = ix.warm();
    const rebuildP = ix.rebuild(); // e.g. user ran callchain.reindex
    await Promise.all([warmP, rebuildP]);

    expect(scans()).toBe(1); // exactly the explicit rebuild

    // Patch state must be usable (populated by the rebuild, not clobbered
    // by a late-committing warm).
    const target = path.join(root, "Project", "Sources", "Methods", "MyLength.4dm");
    fs.utimesSync(target, new Date(), new Date());
    await ix.patchFile(target);
    expect(scans()).toBe(1); // still no extra rebuild
    expect(ix.getLastPatchStats()?.files).toBe(1);
  });

  it("synth refcounts reconstructed by warm survive a delete patch (no drift fallback)", async () => {
    const root = mkTmpFixture();
    // Two callers of the same nonexistent method share one Unresolved synth.
    const a = path.join(root, "Project", "Sources", "Methods", "GhostCallerA.4dm");
    const b = path.join(root, "Project", "Sources", "Methods", "GhostCallerB.4dm");
    fs.writeFileSync(a, "GhostlyMethod($x)\n");
    fs.writeFileSync(b, "GhostlyMethod($x)\n");
    await primeCache(root);

    const { ix, scans, drift } = countingIndexer(root);
    await ix.load();
    await ix.warm();

    // Remove one caller: the shared synth must survive (A still refers to it)
    // and the refcount invariant must hold over the warm-reconstructed
    // synthOwnersByPath — drift would log a warning and force a rebuild.
    fs.unlinkSync(b);
    await ix.patchFile(b, "delete");

    expect(drift()).toBe(0);
    expect(scans()).toBe(0);
    const patched = (ix.getGraph() as any).root as SymbolIndex;
    expect(patched.symbols.some((s) => s.kind === ("Unresolved" as any) && s.name === "GhostlyMethod")).toBe(true);

    const fresh = await freshIndex(root);
    expect(sortSymbols(patched)).toEqual(sortSymbols(fresh));
    expect(sortEdges(patched)).toEqual(sortEdges(fresh));
  });
});
