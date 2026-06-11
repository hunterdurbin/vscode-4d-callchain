import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Indexer, INDEX_VERSION } from "../../packages/core/dist";
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
  if (!fixture) throw new Error("Mini-fixture not available — set FOURD_TEST_PROJECT or commit test/fixtures/mini-4d/");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "callchain-patch-"));
  copyDir(fixture, tmp);
  return tmp;
}

function silentLogger() {
  return { info() {}, warn() {}, error() {} };
}

async function freshIndex(root: string): Promise<SymbolIndex> {
  const ix = new Indexer({
    projectRoot: root,
    exclusions: ["DerivedData", "Libraries", ".git", "node_modules"],
    logger: silentLogger() as any,
    cacheDir: path.join(root, ".vscode-fresh") // avoid colliding with the patched-indexer's cache
  });
  const g = await ix.load();
  const idx: any = (g as any).root;
  return idx as SymbolIndex;
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

async function buildPatched(root: string, mutate: () => Promise<void> | void, changedPaths: string[]): Promise<SymbolIndex> {
  const ix = new Indexer({
    projectRoot: root,
    exclusions: ["DerivedData", "Libraries", ".git", "node_modules"],
    logger: silentLogger() as any
  });
  await ix.load();
  await mutate();
  for (const p of changedPaths) {
    // Bump mtime by 100ms so the rebuild isFresh() check would invalidate
    // (not strictly needed for the patch path; defensive).
    try { fs.utimesSync(p, new Date(), new Date()); } catch {/* ignore */}
    await ix.patchFile(p);
  }
  return (ix.getGraph() as any).root as SymbolIndex;
}

describe("incremental indexing (patchFile)", () => {
  if (!resolveFixture()) {
    it.skip("no fixture available", () => {});
    return;
  }

  it("INDEX_VERSION is 45 after the case_label_arm `_if_tail` edge fix", () => {
    expect(INDEX_VERSION).toBe(45);
  });

  it("pure body edit produces the same symbols + edges as a fresh rebuild", async () => {
    const root = mkTmpFixture();
    const target = path.join(root, "Project", "Sources", "Methods", "MyLength.4dm");
    const original = fs.readFileSync(target, "utf8");

    const patched = await buildPatched(
      root,
      () => fs.writeFileSync(target, original.replace("Length($s)+1", "Length($s)+2")),
      [target]
    );
    const fresh = await freshIndex(root);

    expect(sortSymbols(patched)).toEqual(sortSymbols(fresh));
    expect(sortEdges(patched)).toEqual(sortEdges(fresh));
  });

  it("patching the same file repeatedly does not accumulate duplicate edges", async () => {
    const root = mkTmpFixture();
    const target = path.join(root, "Project", "Sources", "Methods", "MyLength.4dm");
    const original = fs.readFileSync(target, "utf8");

    // Apply the same edit and re-patch the file several times. Each patch must
    // remove-then-(deduped-)add, so the edge set never grows beyond a single
    // rebuild's. Before edges were deduped on append, a replayed add doubled
    // every call site (see INDEX_VERSION 37).
    const patched = await buildPatched(
      root,
      () => fs.writeFileSync(target, original.replace("Length($s)+1", "Length($s)+2")),
      [target, target, target]
    );
    const fresh = await freshIndex(root);

    // No edge appears more than once for the patched file's symbols.
    // `access` is part of the dedup key: a same-line property read+write
    // (`This.counter:=This.counter+1`) is two distinct edges, not a duplicate.
    const key = (e: CallEdge) => `${e.fromId}|${e.toId}|${e.line}|${e.callKind}|${e.column}|${e.access ?? ""}`;
    const counts = new Map<string, number>();
    for (const e of patched.edges) counts.set(key(e), (counts.get(key(e)) ?? 0) + 1);
    const dups = [...counts.entries()].filter(([, n]) => n > 1);
    expect(dups).toEqual([]);
    expect(sortEdges(patched)).toEqual(sortEdges(fresh));
  });

  it("removing a typed class property drops its chain-walk metadata (no stale overlay)", async () => {
    const root = mkTmpFixture();
    const target = path.join(root, "Project", "Sources", "Classes", "ConfigRepo.4dm");
    const original = fs.readFileSync(target, "utf8");
    expect(original).toContain("property cache : cs.Map");

    // Remove the property declaration. `This.cache.get/set` chains inside the
    // class previously kept resolving through the deleted property's type
    // because addFileContribution merged class overlays without ever deleting
    // stale entries. The patched index must match a fresh rebuild exactly.
    const patched = await buildPatched(
      root,
      () => fs.writeFileSync(target, original.replace(/^property cache : cs\.Map\r?\n/m, "")),
      [target]
    );
    const fresh = await freshIndex(root);

    expect(sortSymbols(patched)).toEqual(sortSymbols(fresh));
    expect(sortEdges(patched)).toEqual(sortEdges(fresh));
  });

  it("adding a project method exposes a new ProjectMethod symbol identical to a rebuild", async () => {
    const root = mkTmpFixture();
    const newMethod = path.join(root, "Project", "Sources", "Methods", "NewlyAdded.4dm");

    const patched = await buildPatched(
      root,
      () => fs.writeFileSync(newMethod, "#DECLARE() -> $r : Number\nreturn 42\n"),
      [newMethod]
    );
    const fresh = await freshIndex(root);

    const patchedHas = patched.symbols.some((s) => s.kind === ("ProjectMethod" as any) && s.name === "NewlyAdded");
    expect(patchedHas).toBe(true);
    expect(sortSymbols(patched)).toEqual(sortSymbols(fresh));
    expect(sortEdges(patched)).toEqual(sortEdges(fresh));
  });

  it("deleting a project method removes the symbol identically to a rebuild", async () => {
    const root = mkTmpFixture();
    const target = path.join(root, "Project", "Sources", "Methods", "GetTotal.4dm");

    const patched = await buildPatched(
      root,
      () => fs.unlinkSync(target),
      [target]
    );
    const fresh = await freshIndex(root);

    const patchedHas = patched.symbols.some(
      (s) => s.kind === ("ProjectMethod" as any) && s.name === "GetTotal"
    );
    expect(patchedHas).toBe(false);
    expect(sortSymbols(patched)).toEqual(sortSymbols(fresh));
  });

  it("creating a new .4dm and then patching shows the new symbol", async () => {
    const root = mkTmpFixture();
    const created = path.join(root, "Project", "Sources", "Methods", "BrandNew.4dm");

    const patched = await buildPatched(
      root,
      () => fs.writeFileSync(created, "// LOCKS: created mid-patch\nALERT(\"hi\")\n"),
      [created]
    );
    const fresh = await freshIndex(root);

    const patchedHas = patched.symbols.some(
      (s) => s.kind === ("ProjectMethod" as any) && s.name === "BrandNew"
    );
    expect(patchedHas).toBe(true);
    expect(sortSymbols(patched)).toEqual(sortSymbols(fresh));
  });

  it("renaming a project method file re-resolves callers in other files", async () => {
    const root = mkTmpFixture();
    const oldPath = path.join(root, "Project", "Sources", "Methods", "MyLength.4dm");
    const newPath = path.join(root, "Project", "Sources", "Methods", "MyLengthRenamed.4dm");

    const patched = await buildPatched(
      root,
      () => fs.renameSync(oldPath, newPath),
      [oldPath, newPath]
    );
    const fresh = await freshIndex(root);

    // Old name is gone, new name appears, AND callers of the old name now
    // route to Unresolved (a fresh rebuild produces the same shape).
    const patchedHasOld = patched.symbols.some(
      (s) => s.kind === ("ProjectMethod" as any) && s.name === "MyLength"
    );
    const patchedHasNew = patched.symbols.some(
      (s) => s.kind === ("ProjectMethod" as any) && s.name === "MyLengthRenamed"
    );
    expect(patchedHasOld).toBe(false);
    expect(patchedHasNew).toBe(true);
    expect(sortSymbols(patched)).toEqual(sortSymbols(fresh));
    expect(sortEdges(patched)).toEqual(sortEdges(fresh));
  });

  it("synth: single-source unresolved disappears when its caller is removed", async () => {
    const root = mkTmpFixture();
    const target = path.join(root, "Project", "Sources", "Methods", "Diagnostics_UnresolvedCalls.4dm");

    // Drop the only call site for IntPhantom_DoesNotExist1 — its synth has
    // exactly one fileOrigins entry (Diagnostics_UnresolvedCalls.4dm) so it
    // must disappear from the graph after the patch.
    const original = fs.readFileSync(target, "utf8");
    const patched = await buildPatched(
      root,
      () => fs.writeFileSync(target, original.replace(/^IntPhantom_DoesNotExist1$/m, "// removed")),
      [target]
    );

    const patchedHas = patched.symbols.some(
      (s) => s.kind === ("Unresolved" as any) && s.name === "IntPhantom_DoesNotExist1"
    );
    expect(patchedHas).toBe(false);

    const fresh = await freshIndex(root);
    expect(sortSymbols(patched)).toEqual(sortSymbols(fresh));
  });

  it("synth: shared unresolved persists when only one caller is removed", async () => {
    const root = mkTmpFixture();
    // Two files referencing the same nonexistent method 'GhostlyMethod'.
    // Parenthesized form so the resolver classifies it as BareName (which
    // creates an Unresolved synth on miss) rather than ProjectMethodBare
    // (which drops silently).
    const a = path.join(root, "Project", "Sources", "Methods", "GhostCallerA.4dm");
    const b = path.join(root, "Project", "Sources", "Methods", "GhostCallerB.4dm");
    fs.writeFileSync(a, "GhostlyMethod($x)\n");
    fs.writeFileSync(b, "GhostlyMethod($x)\n");

    // Initial index includes both callers + a single shared Unresolved synth.
    // Then we patch file B to remove its call. The synth must remain because
    // A still references it.
    const patched = await buildPatched(
      root,
      () => fs.writeFileSync(b, "// no calls now\n"),
      [a, b]
    );
    const patchedHas = patched.symbols.some(
      (s) => s.kind === ("Unresolved" as any) && s.name === "GhostlyMethod"
    );
    expect(patchedHas).toBe(true);

    const fresh = await freshIndex(root);
    expect(sortSymbols(patched)).toEqual(sortSymbols(fresh));
    expect(sortEdges(patched)).toEqual(sortEdges(fresh));
  });

  it("patch batch (rename via delete + create) emits a single graph update", async () => {
    const root = mkTmpFixture();
    const oldPath = path.join(root, "Project", "Sources", "Methods", "MyLength.4dm");
    const newPath = path.join(root, "Project", "Sources", "Methods", "MyLengthRenamed.4dm");

    const ix = new (await import("../../packages/core/dist")).Indexer({
      projectRoot: root,
      exclusions: ["DerivedData", "Libraries", ".git", "node_modules"],
      logger: silentLogger() as any
    });
    await ix.load();

    let updates = 0;
    ix.onDidUpdate(() => updates++);

    fs.renameSync(oldPath, newPath);
    await ix.patchFiles([
      { path: oldPath, kind: "delete" },
      { path: newPath, kind: "create" }
    ]);

    expect(updates).toBe(1);
  });
});
