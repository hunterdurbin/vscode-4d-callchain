import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { Indexer } from "../../packages/core/dist";

/**
 * Skip-by-default performance smoke for the incremental patch path.
 * Set FOURD_TEST_PROJECT to a real (large-scale) project to opt in; the
 * mini-fixture is too small to make these thresholds meaningful.
 */
const real = process.env.FOURD_TEST_PROJECT;
const skip = !real || !fs.existsSync(path.join(real, "Project"));

(skip ? describe.skip : describe)("patchFile perf (FOURD_TEST_PROJECT only)", () => {
  it("body-edit patch returns under 500 ms after warm rebuild", async () => {
    const ix = new Indexer({
      projectRoot: real!,
      exclusions: ["DerivedData", "Libraries", ".git", "node_modules"],
      logger: { info() {}, warn() {}, error() {} } as any,
      cacheDir: fs.mkdtempSync(path.join(require("node:os").tmpdir(), "perf-"))
    });
    await ix.load();

    // Pick the first .4dm we can find under Project/Sources/Methods.
    const methodsDir = path.join(real!, "Project", "Sources", "Methods");
    const target = fs
      .readdirSync(methodsDir)
      .find((f) => f.endsWith(".4dm"));
    if (!target) throw new Error("no .4dm found under Project/Sources/Methods");
    const targetPath = path.join(methodsDir, target);

    // Touch the mtime so the patch path treats the file as changed without
    // actually modifying its contents (keeps the project clean for the user).
    fs.utimesSync(targetPath, new Date(), new Date());

    const start = Date.now();
    await ix.patchFile(targetPath);
    const elapsed = Date.now() - start;
    // 500 ms is the v1 target; if a regression triples this on a large project, fail.
    expect(elapsed).toBeLessThan(500);

    // Repeated warm patches must stay fan-out-bounded: with the persistent
    // resolver scratch the per-save cost is O(changed file + cross-file
    // fan-out), not O(project symbols). 200 ms average is generous for a
    // single-file body edit even on 20k+ file projects.
    const ITERS = 5;
    const t0 = Date.now();
    for (let i = 0; i < ITERS; i++) {
      fs.utimesSync(targetPath, new Date(), new Date());
      await ix.patchFile(targetPath);
    }
    const avg = (Date.now() - t0) / ITERS;
    expect(avg).toBeLessThan(200);

    const stats = ix.getLastPatchStats();
    expect(stats).toBeTruthy();
    // Phase budget: symbol add + cross-file fan-out together (the parts the
    // persistent scratch optimizes) must not dominate. Parse time is excluded
    // — it scales with the edited file, not the project.
    expect(stats!.addMs + stats!.fanoutMs).toBeLessThan(150);
  });
});
