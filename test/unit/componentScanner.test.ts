import { describe, expect, it } from "vitest";
import * as path from "path";

const componentScanner = require("../../packages/core/dist/indexer/componentScanner");

// The dev-machine `/Applications/4D*.app/Contents/Components` probe is
// exercised in integration only — these tests inject explicit roots so
// behavior is identical across CI and local runs.
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const STUB_BUNDLED_ROOT = path.join(REPO_ROOT, "test/fixtures/bundled-components-stub");
const STUB_BUNDLED_OVERLAP = path.join(REPO_ROOT, "test/fixtures/bundled-components-stub-overlap");
const STUB_LOCAL_PROJECT = path.join(REPO_ROOT, "test/fixtures/local-components-stub");

describe("componentScanner.discoverComponents — bundled-component discovery", () => {
  it("picks up .4dbase folders from an injected bundled root", () => {
    const components = componentScanner.discoverComponents("/tmp/nonexistent-project", {
      bundledComponentRoots: [STUB_BUNDLED_ROOT]
    });
    const names = new Set(components.map((c: any) => c.name));
    expect(names.has("4D Widgets")).toBe(true);
    expect(names.has("4D NetKit")).toBe(true);
  });

  it("returns no components when no bundled roots and no project Components/", () => {
    const components = componentScanner.discoverComponents("/tmp/nonexistent-project", {
      bundledComponentRoots: []
    });
    expect(components).toEqual([]);
  });

  it("project-local wins over bundled on name collision", () => {
    // Both roots contain `datetime-4d.4dbase`. Project-local should appear
    // exactly once, with bundlePath pointing at the project's Components/.
    const components = componentScanner.discoverComponents(STUB_LOCAL_PROJECT, {
      bundledComponentRoots: [STUB_BUNDLED_OVERLAP]
    });
    const matches = components.filter((c: any) => c.name === "datetime-4d");
    expect(matches.length).toBe(1);
    expect(matches[0].bundlePath).toContain("/local-components-stub/Components/");
  });

  it("emits a DiscoveredComponent even when the .4dbase has no .4DZ archive", () => {
    // Stub bundles intentionally ship no .4DZ — verifies the scanner doesn't
    // bail on metadata-less bundles (a real 4D install always has them,
    // but a partial install or dev workspace might not).
    const components = componentScanner.discoverComponents("/tmp/nonexistent-project", {
      bundledComponentRoots: [STUB_BUNDLED_ROOT]
    });
    const widgets = components.find((c: any) => c.name === "4D Widgets");
    expect(widgets).toBeTruthy();
    expect(widgets.zipPath).toBeUndefined();
    expect(widgets.methods).toEqual([]);
    expect(widgets.classes).toEqual([]);
    expect(widgets.classStoreName).toBe("4D Widgets"); // falls back to dir name
  });
});

describe("componentScanner.findBundledComponentRoots", () => {
  it("returns string paths (smoke test — empty on machines without 4D installed)", () => {
    const roots = componentScanner.findBundledComponentRoots();
    expect(Array.isArray(roots)).toBe(true);
    for (const r of roots) expect(typeof r).toBe("string");
  });
});
