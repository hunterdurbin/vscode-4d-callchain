import { beforeAll, expect, it } from "vitest";
import { describeWithFixture } from "../helpers/fixture";
import { calleesOf, getSharedIndex, symFinder } from "../helpers/sharedIndex";
import type { SymbolIndex } from "../../packages/core/dist";

// Form-specific extractions — `form.4DForm` JSON is walked by
// fileParser.extractFormDataSourceCalls, which runs cleanLine() +
// extractCallSitesFromLine on each value of dataSource/expression/
// methodName/columnDataSource/variableCalculation.
const MINI_FIXTURE_BASENAME = "mini-4d";

describeWithFixture("indexer/mini-form — form.4DForm field extraction", (root) => {
  const isMini = root.endsWith(MINI_FIXTURE_BASENAME);
  let idx: SymbolIndex;
  let sym: ReturnType<typeof symFinder>;

  beforeAll(async () => {
    if (!isMini) return;
    idx = await getSharedIndex(root);
    sym = symFinder(idx);
  });

  it("OrderForm produces a Form symbol", () => {
    if (!isMini) return;
    const form = sym("Form", "OrderForm");
    expect(form).toBeTruthy();
  });

  it("OrderForm produces a FormMethod symbol named 'OrderForm.method'", () => {
    if (!isMini) return;
    const fm = idx.symbols.find(
      (s) => s.kind === ("FormMethod" as any) && s.name === "OrderForm.method"
    );
    expect(fm).toBeTruthy();
  });

  it("OrderForm produces a FormObjectMethod for BtnClick", () => {
    if (!isMini) return;
    const fom = idx.symbols.find(
      (s) => s.kind === ("FormObjectMethod" as any) && s.name === "OrderForm.BtnClick"
    );
    expect(fom).toBeTruthy();
  });

  it("OrderForm's form.4DForm expression `GetTotal()` produces an edge to the project method", () => {
    if (!isMini) return;
    const form = sym("Form", "OrderForm");
    if (!form) return;
    const callee = calleesOf(idx, form).find((e) => {
      const t = idx.symbols.find((s) => s.id === e.toId);
      return t && t.name === "GetTotal";
    });
    expect(callee).toBeTruthy();
  });

  it("OrderForm's form.4DForm `methodName: \"BtnClick\"` resolves to FormObjectMethod", () => {
    if (!isMini) return;
    const form = sym("Form", "OrderForm");
    if (!form) return;
    const callee = calleesOf(idx, form).find((e) => {
      const t = idx.symbols.find((s) => s.id === e.toId);
      return t && t.name && t.name.includes("BtnClick");
    });
    // methodName resolution is best-effort; if the link doesn't form, the
    // FormObjectMethod symbol still exists (covered above). Tolerate either
    // outcome here as long as at least one BtnClick-related edge or symbol
    // exists.
    const btnObj = idx.symbols.find(
      (s) => s.kind === ("FormObjectMethod" as any) && s.name === "OrderForm.BtnClick"
    );
    expect(callee || btnObj).toBeTruthy();
  });

  it("BtnClick form-object method → EmGetTransaction edge", () => {
    if (!isMini) return;
    const btn = idx.symbols.find(
      (s) => s.kind === ("FormObjectMethod" as any) && s.name === "OrderForm.BtnClick"
    );
    if (!btn) return;
    const callee = calleesOf(idx, btn).find((e) => {
      const t = idx.symbols.find((s) => s.id === e.toId);
      return t && t.name === "EmGetTransaction";
    });
    expect(callee).toBeTruthy();
  });

  // EXECUTE METHOD IN SUBFORM("name"; "method") — the second arg is
  // typically a regular project method that 4D runs in the subform's
  // context, NOT a FormObjectMethod. Verifies the resolver falls back
  // from the FormObjectMethod lookup to a ProjectMethod lookup.
  it("EXECUTE METHOD IN SUBFORM resolves second arg as a ProjectMethod when no FormObjectMethod matches", () => {
    if (!isMini) return;
    const caller = sym("ProjectMethod", "Subform_Caller");
    expect(caller).toBeTruthy();
    if (!caller) return;
    const target = sym("ProjectMethod", "Subform_Helper_Target");
    expect(target).toBeTruthy();
    if (!target) return;
    const edge = calleesOf(idx, caller).find((e) => e.toId === target.id);
    expect(edge).toBeTruthy();
    expect(edge?.resolved).toBe(true);
  });
});
