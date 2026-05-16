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
});
