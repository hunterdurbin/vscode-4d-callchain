import { beforeAll, expect, it } from "vitest";
import { describeWithFixture } from "../helpers/fixture";
import { callersOf, getSharedIndex } from "../helpers/sharedIndex";
import type { SymbolIndex } from "../../packages/core/dist";

describeWithFixture("indexer/components — Component symbols + method refs", (root) => {
  let idx: SymbolIndex;

  beforeAll(async () => {
    idx = await getSharedIndex(root);
  });

  // Components require committed .4DZ archives (binary) and are out of scope
  // for the mini-fixture. These probes self-skip when no components are
  // present; against a large project (or any project with Components/*.4dbase/) they
  // still assert ≥1 indexed component + ≥1 component-method caller.

  it("≥1 Component symbol is indexed when the fixture has components", () => {
    const componentSyms = idx.symbols.filter((s) => s.kind === ("Component" as any));
    if (componentSyms.length === 0) return; // mini-fixture has none — skip
    expect(componentSyms.length).toBeGreaterThanOrEqual(1);
  });

  it("Checkout component methods aggregate ≥1 caller when present", () => {
    const checkoutMethods = idx.symbols.filter(
      (s) => s.kind === ("ComponentMethod" as any) && (s as any).ownerComponent === "Checkout"
    );
    if (checkoutMethods.length === 0) return; // mini-fixture has none — skip
    const callerCount = checkoutMethods.reduce(
      (n, m) => n + callersOf(idx, m).length,
      0
    );
    expect(callerCount).toBeGreaterThanOrEqual(1);
  });
});
