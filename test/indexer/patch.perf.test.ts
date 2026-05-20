import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { Indexer } from "../../packages/core/dist";

/**
 * Skip-by-default performance smoke for the incremental patch path.
 * Set FOURD_TEST_PROJECT to a real (symphony-scale) project to opt in; the
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
    // 500 ms is the v1 target; if a regression triples this on symphony, fail.
    expect(elapsed).toBeLessThan(500);
  });
});
