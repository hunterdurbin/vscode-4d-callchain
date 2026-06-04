import { beforeAll, expect, it } from "vitest";
import * as path from "path";
import { describeWithFixture } from "../helpers/fixture";
import { buildTreeSitterIndex, initTreeSitter, isTreeSitterReady, parseWithTreeSitter } from "../helpers/treeSitterIndex";
import type { SymbolIndex } from "../../packages/core/dist";

// Exercises the tree-sitter parser specifically (the default in the real
// extension), so it must init the WASM grammar and build the index through
// it — unlike the shared-index helper, which falls back to the regex parser
// when tree-sitter isn't ready. Locks in the `cs.X.new().method()` single-
// line chain fix: the method invoked on the freshly-constructed instance
// must emit a resolved CsChainCall edge (previously skipped entirely).

const MINI_FIXTURE_BASENAME = "mini-4d";

describeWithFixture("indexer/cs-chain-resolution — cs.X.new().method() chains", (root) => {
  const isMini = root.endsWith(MINI_FIXTURE_BASENAME);
  let idx: SymbolIndex;

  beforeAll(async () => {
    if (!isMini) return;
    await initTreeSitter();
    expect(isTreeSitterReady()).toBe(true);
    idx = buildTreeSitterIndex(root);
  });

  it("emits a CsChainCall hint for a single-line cs.X.new().method() chain", () => {
    if (!isMini) return;
    const absolutePath = path.join(
      root,
      "Project",
      "Sources",
      "Classes",
      "OrderHydrator_Test.4dm"
    );
    const parsed = parseWithTreeSitter({
      absolutePath,
      relativePath: "Project/Sources/Classes/OrderHydrator_Test.4dm",
      category: "class"
    });
    const hint = parsed.rawCalls
      .map((c: any) => c.hint)
      .find((h: any) => h && h.kind === "CsChainCall");
    expect(hint).toBeTruthy();
    expect(hint.className).toBe("OrderHydrator");
    expect(hint.method).toBe("getNormalizedInvoiceFromDatastore");
  });

  it("resolves the chained method to OrderHydrator.getNormalizedInvoiceFromDatastore", () => {
    if (!isMini) return;
    const from = idx.symbols.find(
      (s: any) =>
        s.kind === "ClassFunction" &&
        s.name === "test_chainedNew" &&
        s.ownerClass === "OrderHydrator_Test"
    );
    expect(from).toBeTruthy();
    if (!from) return;
    const callee = idx.edges
      .filter((e) => e.fromId === from.id)
      .find((e) => idx.symbols.find((s) => s.id === e.toId)?.name === "getNormalizedInvoiceFromDatastore");
    expect(callee).toBeTruthy();
    expect(callee?.resolved).toBe(true);
  });
});
