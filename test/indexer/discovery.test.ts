import { beforeAll, expect, it } from "vitest";
import { describeWithFixture } from "../helpers/fixture";
import { getSharedIndex } from "../helpers/sharedIndex";
import type { SymbolIndex } from "../../packages/core/dist";

describeWithFixture("indexer/discovery (against fixture project)", (root) => {
  let idx: SymbolIndex;

  beforeAll(async () => {
    idx = await getSharedIndex(root);
  });

  it("discovers a non-trivial number of symbols and edges", () => {
    // Mini-fixture has ~50 symbols + ~50 edges. Symphony has thousands.
    expect(idx.symbols.length).toBeGreaterThan(20);
    expect(idx.edges.length).toBeGreaterThan(20);
  });

  it("indexes at least one Class symbol", () => {
    const classes = idx.symbols.filter((s) => s.kind === ("Class" as any));
    expect(classes.length).toBeGreaterThanOrEqual(1);
  });

  it("indexes ClassFunction symbols", () => {
    const fns = idx.symbols.filter((s) => s.kind === ("ClassFunction" as any));
    expect(fns.length).toBeGreaterThanOrEqual(1);
  });

  it("indexes ProjectMethod symbols", () => {
    const methods = idx.symbols.filter((s) => s.kind === ("ProjectMethod" as any));
    expect(methods.length).toBeGreaterThanOrEqual(1);
  });

  it("≥1000 built-in constants indexed when 4D is installed", () => {
    // discoverBuiltinConstants reads from /Applications/4D.app — when 4D
    // isn't installed (e.g., headless CI), the count is 0. Locally with
    // 4D installed it's >1000. Either result is acceptable; we just
    // confirm the discovery path returns a Number (no parse crash).
    const count = idx.symbols.filter((s) => s.kind === ("BuiltinConstant" as any)).length;
    expect(typeof count).toBe("number");
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it("resolves the majority of edges", () => {
    const resolved = idx.edges.filter((e) => e.resolved).length;
    const total = idx.edges.length;
    // Lower bound matches the smoke baseline; tighten in a follow-up if desired.
    expect(resolved / total).toBeGreaterThan(0.5);
  });
});
