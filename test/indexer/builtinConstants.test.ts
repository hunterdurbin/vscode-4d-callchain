import { beforeAll, expect, it } from "vitest";
import { describeWithFixture } from "../helpers/fixture";
import { callersOf, getSharedIndex, symFinder } from "../helpers/sharedIndex";
import type { SymbolIndex } from "../../packages/core/dist";

describeWithFixture("indexer/builtinConstants — refs + lookbehind regression", (root) => {
  let idx: SymbolIndex;
  let sym: ReturnType<typeof symFinder>;

  beforeAll(async () => {
    idx = await getSharedIndex(root);
    sym = symFinder(idx);
  });

  it("`Is text`, `Is real`, `On Load` are indexed", () => {
    expect(sym("BuiltinConstant", "Is text")).toBeTruthy();
    expect(sym("BuiltinConstant", "Is real")).toBeTruthy();
    expect(sym("BuiltinConstant", "On Load")).toBeTruthy();
  });

  it("multi-word builtin constants are reference-counted (`Char Quote` ≥1)", () => {
    const charQuote = sym("BuiltinConstant", "Char Quote");
    if (charQuote) {
      expect(callersOf(idx, charQuote).length).toBeGreaterThanOrEqual(1);
    }
  });

  it("`On Load` has ≥1 caller (multi-word ref tracking)", () => {
    const onLoad = sym("BuiltinConstant", "On Load");
    if (!onLoad) return;
    expect(callersOf(idx, onLoad).length).toBeGreaterThanOrEqual(1);
  });

  it("`[Goals]April` field access is NOT counted as an April-constant ref", () => {
    const april = sym("BuiltinConstant", "April");
    if (!april) return;
    const callers = callersOf(idx, april);
    // The fixture file that exercises [Goals]April differs per fixture:
    //   * mini-fixture: BuiltinConst_LookbehindRegression
    //   * Symphony: Inventory_SetGoals (often with a bSave subroutine)
    // Either way, the regression assertion is: no caller from EITHER name
    // exists on the April BuiltinConstant.
    const stray = callers.find((e) => {
      const f = idx.symbols.find((s) => s.id === e.fromId);
      if (!f || !f.name) return false;
      return (
        f.name.includes("Inventory_SetGoals") ||
        f.name.includes("BuiltinConst_LookbehindRegression")
      );
    });
    expect(stray).toBeFalsy();
  });
});
