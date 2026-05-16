import { beforeAll, expect, it } from "vitest";
import { describeWithFixture } from "../helpers/fixture";
import { callersOf, getSharedIndex } from "../helpers/sharedIndex";
import type { SymbolIndex } from "../../packages/core/dist";

describeWithFixture("indexer/variables — interprocess + process", (root) => {
  let idx: SymbolIndex;

  beforeAll(async () => {
    idx = await getSharedIndex(root);
  });

  it("≥2 interprocess variables indexed", () => {
    // Mini-fixture has exactly 2; Symphony has 100+. Bound is mini-floor.
    const ip = idx.symbols.filter((s) => s.kind === ("InterprocessVariable" as any));
    expect(ip.length).toBeGreaterThanOrEqual(2);
  });

  it("≥3 process variables indexed", () => {
    // Mini-fixture has exactly 3; Symphony has 10+. Bound is mini-floor.
    const proc = idx.symbols.filter((s) => s.kind === ("ProcessVariable" as any));
    expect(proc.length).toBeGreaterThanOrEqual(3);
  });

  it("<>aALPAlph1 is indexed and referenced", () => {
    const alp = idx.symbols.find(
      (s) => s.kind === ("InterprocessVariable" as any) && s.name === "aALPAlph1"
    );
    expect(alp).toBeTruthy();
    if (alp) expect(callersOf(idx, alp).length).toBeGreaterThanOrEqual(1);
  });

  it("aLineItems_Description (process var) is referenced when present", () => {
    const v = idx.symbols.find(
      (s) => s.kind === ("ProcessVariable" as any) && s.name === "aLineItems_Description"
    );
    // Optional probe — symphony evolution may rename it. If present, callers must be ≥1.
    if (v) expect(callersOf(idx, v).length).toBeGreaterThanOrEqual(1);
  });
});
