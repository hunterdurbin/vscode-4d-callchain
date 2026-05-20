import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { unpack } from "msgpackr";
import { Indexer, classifyChange } from "../../packages/core/dist";
import type { SymbolIndex } from "../../packages/core/dist";
import { resolveFixture } from "../helpers/fixture";

function readCache(p: string): SymbolIndex {
  return unpack(fs.readFileSync(p)) as SymbolIndex;
}

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "callchain-watching-"));
  copyDir(fixture, tmp);
  return tmp;
}

function silentLogger() {
  return { info() {}, warn() {}, error() {} };
}

describe("patchFile dispatcher routes non-.4dm to full rebuild", () => {
  if (!resolveFixture()) {
    it.skip("no fixture available", () => {});
    return;
  }

  it("constants edit triggers a full rebuild that picks up the new constant", async () => {
    const root = mkTmpFixture();
    const xlfPath = path.join(root, "Resources", "Constants_Project.xlf");
    const original = fs.readFileSync(xlfPath, "utf8");
    // Insert a fresh trans-unit before the closing </body> tag. We use a
    // distinctive name so we can assert the new Constant symbol appears.
    const updated = original.replace(
      "</body>",
      `  <trans-unit d4:value="freshly_added:S" id="k_9999">\n    <source>_FreshlyAddedConstant</source>\n  </trans-unit>\n</body>`
    );

    const ix = new Indexer({
      projectRoot: root,
      exclusions: ["DerivedData", "Libraries", ".git", "node_modules"],
      logger: silentLogger() as any
    });
    await ix.load();

    // Sanity: the constant doesn't exist yet.
    const before = (ix.getGraph() as any).root as SymbolIndex;
    expect(before.symbols.some((s) => s.name === "_FreshlyAddedConstant")).toBe(false);

    // Patch via the constants path → should trigger a full rebuild.
    fs.writeFileSync(xlfPath, updated);
    await ix.patchFile(xlfPath);

    const after = (ix.getGraph() as any).root as SymbolIndex;
    expect(after.symbols.some(
      (s) => s.kind === ("Constant" as any) && s.name === "_FreshlyAddedConstant"
    )).toBe(true);
  });

  it("components path classifies even without a real .4dbase bundle", () => {
    expect(classifyChange("/proj/Components/Foo.4dbase/Foo.4DZ", "/proj")).toBe("components");
  });

  it("mixed batch: .4dm + constants emits a single onDidUpdate via full rebuild", async () => {
    const root = mkTmpFixture();
    const xlfPath = path.join(root, "Resources", "Constants_Project.xlf");
    const dmPath = path.join(root, "Project", "Sources", "Methods", "MyLength.4dm");

    const ix = new Indexer({
      projectRoot: root,
      exclusions: ["DerivedData", "Libraries", ".git", "node_modules"],
      logger: silentLogger() as any
    });
    await ix.load();

    let updates = 0;
    ix.onDidUpdate(() => updates++);

    // Touch both files; submit them in one batch.
    fs.utimesSync(xlfPath, new Date(), new Date());
    fs.utimesSync(dmPath, new Date(), new Date());
    await ix.patchFiles([
      { path: dmPath, kind: "change" },
      { path: xlfPath, kind: "change" }
    ]);

    // Exactly one update: the full rebuild that constants triggered.
    expect(updates).toBe(1);
  });

  it("isFresh: a stale constants mtime in the cache forces a rebuild on next load", async () => {
    const root = mkTmpFixture();
    const xlfPath = path.join(root, "Resources", "Constants_Project.xlf");

    // 1) First load builds the cache fresh.
    const ixWarm = new Indexer({
      projectRoot: root,
      exclusions: ["DerivedData", "Libraries", ".git", "node_modules"],
      logger: silentLogger() as any
    });
    await ixWarm.load();
    const cachePath = path.join(root, ".vscode", "callchain-index.msgpack");
    expect(fs.existsSync(cachePath)).toBe(true);

    // 2) Touch the constants file so its mtime advances beyond the cached value.
    //    Wait briefly so the change exceeds the 1 ms isFresh tolerance reliably.
    await new Promise((r) => setTimeout(r, 20));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(xlfPath, future, future);

    // 3) A fresh Indexer should treat the cache as stale and rebuild on load.
    //    We detect the rebuild by observing the cache's `builtAt` advancing.
    const cachedBefore = readCache(cachePath);
    const ixCold = new Indexer({
      projectRoot: root,
      exclusions: ["DerivedData", "Libraries", ".git", "node_modules"],
      logger: silentLogger() as any
    });
    await ixCold.load();
    const cachedAfter = readCache(cachePath);
    expect(cachedAfter.builtAt).toBeGreaterThan(cachedBefore.builtAt);
  });

  it("concurrent rebuild requests coalesce onto one in-flight promise", async () => {
    const root = mkTmpFixture();
    // Capture "Scanning <root>" log lines as a proxy for how many rebuilds ran.
    let scans = 0;
    const ix = new Indexer({
      projectRoot: root,
      exclusions: ["DerivedData", "Libraries", ".git", "node_modules"],
      logger: {
        info: (m) => { if (m.includes("Scanning")) scans++; },
        warn: () => {},
        error: () => {}
      } as any
    });
    // Five parallel rebuild() calls should produce exactly one scan.
    await Promise.all([ix.rebuild(), ix.rebuild(), ix.rebuild(), ix.rebuild(), ix.rebuild()]);
    expect(scans).toBe(1);
  });

  it("patches issued during a rebuild await it instead of starting another", async () => {
    const root = mkTmpFixture();
    let scans = 0;
    const ix = new Indexer({
      projectRoot: root,
      exclusions: ["DerivedData", "Libraries", ".git", "node_modules"],
      logger: {
        info: (m) => { if (m.includes("Scanning")) scans++; },
        warn: () => {},
        error: () => {}
      } as any
    });

    // Kick off the first rebuild but don't await it.
    const rebuildP = ix.rebuild();

    // While it's running, fire two patches. They should await the same
    // rebuild rather than each triggering their own.
    const dm = path.join(root, "Project", "Sources", "Methods", "MyLength.4dm");
    const patchPs = [
      ix.patchFile(dm),
      ix.patchFile(dm)
    ];
    await Promise.all([rebuildP, ...patchPs]);
    expect(scans).toBe(1);
  });

  it("isFresh: a newly-added Constants_*.xlf invalidates the cache via the file-set membership check", async () => {
    const root = mkTmpFixture();
    // Build a cache with the existing constants set.
    const ix1 = new Indexer({
      projectRoot: root,
      exclusions: ["DerivedData", "Libraries", ".git", "node_modules"],
      logger: silentLogger() as any
    });
    await ix1.load();
    const cachePath = path.join(root, ".vscode", "callchain-index.msgpack");
    const cachedBefore = readCache(cachePath);

    // Drop in a brand-new Constants_Extra.xlf and reload.
    await new Promise((r) => setTimeout(r, 20));
    const extra = path.join(root, "Resources", "Constants_Extra.xlf");
    fs.writeFileSync(
      extra,
      `<?xml version="1.0" encoding="UTF-8"?>\n<xliff xmlns:d4="urn:4d:v1" version="1.0">\n  <file source-language="en"><body>\n    <trans-unit d4:value="hello:S" id="k_1"><source>_HelloFromExtra</source></trans-unit>\n  </body></file>\n</xliff>\n`
    );

    const ix2 = new Indexer({
      projectRoot: root,
      exclusions: ["DerivedData", "Libraries", ".git", "node_modules"],
      logger: silentLogger() as any
    });
    await ix2.load();
    const cachedAfter = readCache(cachePath);
    expect(cachedAfter.builtAt).toBeGreaterThan(cachedBefore.builtAt);
  });
});
