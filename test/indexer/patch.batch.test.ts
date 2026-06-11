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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "callchain-batch-"));
  copyDir(fixture, tmp);
  return tmp;
}

function silentLogger() {
  return { info() {}, warn() {}, error() {} };
}

/** Indexer that counts "Scanning" log lines — one per full rebuild. */
function scanCountingIndexer(root: string): { ix: Indexer; scans: () => number } {
  let scans = 0;
  const ix = new Indexer({
    projectRoot: root,
    exclusions: ["DerivedData", "Libraries", ".git", "node_modules"],
    logger: {
      info: (m: string) => { if (m.includes("Scanning")) scans++; },
      warn: () => {},
      error: () => {}
    } as any
  });
  return { ix, scans: () => scans };
}

async function freshIndex(root: string): Promise<SymbolIndex> {
  const ix = new Indexer({
    projectRoot: root,
    exclusions: ["DerivedData", "Libraries", ".git", "node_modules"],
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

describe("agent-scale patch batches (no rebuild bail)", () => {
  if (!resolveFixture()) {
    it.skip("no fixture available", () => {});
    return;
  }

  it("a 60-file batch patches incrementally (no rebuild) and matches a fresh rebuild", async () => {
    const root = mkTmpFixture();
    const { ix, scans } = scanCountingIndexer(root);
    await ix.load(); // cold tmp dir → 1 rebuild
    const scansAfterLoad = scans();

    let updates = 0;
    ix.onDidUpdate(() => updates++);

    // Simulate an agent burst: 60 new method files in one watcher batch —
    // past the old PATCH_BATCH_LIMIT of 50 that bailed to a full rebuild.
    const methodsDir = path.join(root, "Project", "Sources", "Methods");
    const batch: { path: string; kind: "create" }[] = [];
    for (let i = 0; i < 60; i++) {
      const p = path.join(methodsDir, `AgentBurst_${i}.4dm`);
      fs.writeFileSync(p, `#DECLARE($s : Text) -> $r : Integer\nreturn Length($s)+${i}\n`);
      batch.push({ path: p, kind: "create" });
    }
    await ix.patchFiles(batch);

    expect(scans()).toBe(scansAfterLoad); // no additional rebuild
    expect(updates).toBe(1); // one graph refresh for the whole batch

    const patched = (ix.getGraph() as any).root as SymbolIndex;
    const fresh = await freshIndex(root);
    expect(sortSymbols(patched)).toEqual(sortSymbols(fresh));
    expect(sortEdges(patched)).toEqual(sortEdges(fresh));
  });

  it("intra-batch cross-reference: caller and renamed callee in one batch resolve to each other", async () => {
    const root = mkTmpFixture();
    const methodsDir = path.join(root, "Project", "Sources", "Methods");
    const target = path.join(methodsDir, "PairTarget.4dm");
    const targetRenamed = path.join(methodsDir, "PairTargetNew.4dm");
    const caller = path.join(methodsDir, "PairCaller.4dm");
    fs.writeFileSync(target, "#DECLARE($s : Text) -> $r : Integer\nreturn Length($s)\n");
    fs.writeFileSync(caller, "PairTarget($x)\n");

    const { ix, scans } = scanCountingIndexer(root);
    await ix.load();
    const scansAfterLoad = scans();

    // Rename the callee AND retarget the caller in the same batch, with the
    // caller ordered FIRST. The pre-phase-split loop resolved the caller
    // before the renamed callee's symbols existed, leaving a stale Unresolved
    // edge that the fan-out (which skips changedPaths) never repaired.
    fs.renameSync(target, targetRenamed);
    fs.writeFileSync(caller, "PairTargetNew($x)\n");
    await ix.patchFiles([
      { path: caller, kind: "change" },
      { path: target, kind: "delete" },
      { path: targetRenamed, kind: "create" }
    ]);

    expect(scans()).toBe(scansAfterLoad);
    const patched = (ix.getGraph() as any).root as SymbolIndex;
    const fresh = await freshIndex(root);
    expect(sortSymbols(patched)).toEqual(sortSymbols(fresh));
    expect(sortEdges(patched)).toEqual(sortEdges(fresh));
  });

  it("intra-batch delete: surviving caller's edge degrades to Unresolved like a fresh rebuild", async () => {
    const root = mkTmpFixture();
    const methodsDir = path.join(root, "Project", "Sources", "Methods");
    const target = path.join(methodsDir, "PairTarget.4dm");
    const caller = path.join(methodsDir, "PairCaller.4dm");
    fs.writeFileSync(target, "#DECLARE($s : Text) -> $r : Integer\nreturn Length($s)\n");
    fs.writeFileSync(caller, "PairTarget($x)\n");

    const { ix, scans } = scanCountingIndexer(root);
    await ix.load();
    const scansAfterLoad = scans();

    // Delete the callee while the (also-changed) caller still references it,
    // caller ordered first so the old loop would have re-resolved it while
    // the callee's symbols were still present.
    fs.writeFileSync(caller, "// edited in same batch\nPairTarget($x)\n");
    fs.unlinkSync(target);
    await ix.patchFiles([
      { path: caller, kind: "change" },
      { path: target, kind: "delete" }
    ]);

    expect(scans()).toBe(scansAfterLoad);
    const patched = (ix.getGraph() as any).root as SymbolIndex;
    expect(patched.symbols.some((s) => s.kind === ("ProjectMethod" as any) && s.name === "PairTarget")).toBe(false);
    expect(patched.symbols.some((s) => s.kind === ("Unresolved" as any) && s.name === "PairTarget")).toBe(true);

    const fresh = await freshIndex(root);
    expect(sortSymbols(patched)).toEqual(sortSymbols(fresh));
    expect(sortEdges(patched)).toEqual(sortEdges(fresh));
  });
});
