import { beforeAll, expect, it } from "vitest";
import { describeWithFixture } from "../helpers/fixture";
import { calleesOf, callersOf, getSharedIndex, symFinder } from "../helpers/sharedIndex";
import type { SymbolIndex } from "../../packages/core/dist";

describeWithFixture("indexer/symbols — classes, functions, getters/setters", (root) => {
  let idx: SymbolIndex;
  let sym: ReturnType<typeof symFinder>;

  beforeAll(async () => {
    idx = await getSharedIndex(root);
    sym = symFinder(idx);
  });

  it("OrderHydrator class exists", () => {
    expect(sym("Class", "OrderHydrator")).toBeTruthy();
  });

  it("OrderHydrator_Test class exists", () => {
    expect(sym("Class", "OrderHydrator_Test")).toBeTruthy();
  });

  it("OrderHydrator.getNormalizedInvoiceFromDatastore exists with sensible call edges", () => {
    const fn = sym("ClassFunction", "getNormalizedInvoiceFromDatastore", "OrderHydrator");
    expect(fn).toBeTruthy();
    if (!fn) return;
    expect(callersOf(idx, fn).length).toBeGreaterThanOrEqual(1);
    expect(calleesOf(idx, fn).length).toBeGreaterThanOrEqual(3);
  });

  it("OrderHydrator_Test.test_getNormalizedInvoiceFromDatastore exists", () => {
    expect(
      sym("ClassFunction", "test_getNormalizedInvoiceFromDatastore", "OrderHydrator_Test")
    ).toBeTruthy();
  });

  it("NormalizedOrder.shippingCost getter exists", () => {
    expect(sym("ClassGetter", "shippingCost", "NormalizedOrder")).toBeTruthy();
  });

  it("NormalizedOrderItem.splitPercentage getter + setter exist and are referenced", () => {
    const getter = sym("ClassGetter", "splitPercentage", "NormalizedOrderItem");
    const setter = sym("ClassSetter", "splitPercentage", "NormalizedOrderItem");
    expect(getter).toBeTruthy();
    expect(setter).toBeTruthy();
    if (getter) expect(callersOf(idx, getter).length).toBeGreaterThanOrEqual(1);
    if (setter) expect(callersOf(idx, setter).length).toBeGreaterThanOrEqual(1);
  });

  it("RulesEntity computed attribute: getter vs query backer are distinct, query tagged with computedFor", () => {
    const getter = sym("ClassGetter", "isActive", "RulesEntity") as any;
    const query = sym("ClassFunction", "isActive", "RulesEntity") as any;
    expect(getter).toBeTruthy();
    expect(query).toBeTruthy();
    if (getter) expect(getter.accessor).toBe("get");
    if (query) {
      expect(query.accessor).toBe("query");
      expect(query.computedFor).toBe("isActive");
    }
  });

  it("RulesEntity.ruleName Alias is indexed with its target path and linked from references", () => {
    const alias = sym("Alias", "ruleName", "RulesEntity") as any;
    expect(alias).toBeTruthy();
    if (alias) {
      expect(alias.aliasTarget).toBe("rule.Name");
      // Linked from two reference shapes:
      //   * `This.ruleName:=…` in RulesEntity.load() (ThisSet)
      //   * `$eRule.ruleName:=…` in Rules_Test._createActiveRule(), where
      //     $eRule is a dsTable:Rules-typed local → entity class RulesEntity
      //     (VarSet through the dataclass type shape).
      const byId = new Map(idx.symbols.map((s) => [s.id, s.name]));
      const callerNames = callersOf(idx, alias).map((e) => byId.get(e.fromId));
      expect(callerNames).toContain("load");
      expect(callerNames).toContain("_createActiveRule");
    }
  });
});
