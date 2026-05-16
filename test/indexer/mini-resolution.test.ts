import { beforeAll, expect, it } from "vitest";
import { describeWithFixture } from "../helpers/fixture";
import { calleesOf, callersOf, getSharedIndex, symFinder } from "../helpers/sharedIndex";
import type { SymbolIndex } from "../../packages/core/dist";

// One assertion per fixture file's LOCKS comment — each test names the
// parser pattern it locks in. Runs against the mini-fixture only; other
// projects don't contain the same identifiers.
const MINI_FIXTURE_BASENAME = "mini-4d";

describeWithFixture("indexer/mini-resolution — pattern-by-pattern correctness", (root) => {
  const isMini = root.endsWith(MINI_FIXTURE_BASENAME);
  let idx: SymbolIndex;
  let sym: ReturnType<typeof symFinder>;

  beforeAll(async () => {
    if (!isMini) return;
    idx = await getSharedIndex(root);
    sym = symFinder(idx);
  });

  // ---------- Bare-name (parenthesis-less) project method calls ----------

  it("Bare_ParenLessCalls emits bare-statement edges to its _Target1 and _Target2 siblings", () => {
    if (!isMini) return;
    const from = sym("ProjectMethod", "Bare_ParenLessCalls")!;
    const calleeNames = new Set(
      calleesOf(idx, from)
        .map((e) => idx.symbols.find((s) => s.id === e.toId)?.name)
        .filter(Boolean) as string[]
    );
    expect(calleeNames.has("Bare_ParenLessCalls_Target1")).toBe(true);
    expect(calleeNames.has("Bare_ParenLessCalls_Target2")).toBe(true);
  });

  // ---------- CALL WORKER with non-string first arg + string worker name ---

  it("CallWorker_DynamicFirstArg → CallWorker_Target via CALL WORKER", () => {
    if (!isMini) return;
    const from = sym("ProjectMethod", "CallWorker_DynamicFirstArg")!;
    const callee = calleesOf(idx, from).find((e) => {
      const t = idx.symbols.find((s) => s.id === e.toId);
      return t && t.name === "CallWorker_Target";
    });
    expect(callee).toBeTruthy();
  });

  // ---------- [Goals]April lookbehind: April BuiltinConstant must NOT have a
  //            caller from BuiltinConst_LookbehindRegression.4dm ----------

  it("[Goals]April field access is NOT counted as a BuiltinConstant ref", () => {
    if (!isMini) return;
    const lookbehindMethod = sym("ProjectMethod", "BuiltinConst_LookbehindRegression");
    const april = sym("BuiltinConstant", "April");
    if (!april || !lookbehindMethod) return; // April only exists with 4D installed
    const callers = callersOf(idx, april);
    const fromLookbehind = callers.find((e) => e.fromId === lookbehindMethod.id);
    expect(fromLookbehind).toBeUndefined();
  });

  // ---------- Multi-word builtins must NOT leak bare-name Unresolved ------

  it("`RECORD LOCK` consumes the span so no `RECORD` Unresolved leaks", () => {
    if (!isMini) return;
    const stray = idx.symbols.find(
      (s) => s.kind === ("Unresolved" as any) && s.name === "RECORD"
    );
    expect(stray).toBeUndefined();
  });

  // ---------- Compiler_*.4dm classifies as CompilerMethod -----------------

  it("Compiler_Variables.4dm becomes a CompilerMethod symbol", () => {
    if (!isMini) return;
    const compiler = idx.symbols.find(
      (s) => s.kind === ("CompilerMethod" as any) && s.name === "Compiler_Variables"
    );
    expect(compiler).toBeTruthy();
  });

  // ---------- Variables (interprocess + process) --------------------------

  it("<>aALPAlph1 indexed as InterprocessVariable, type Longint, ≥1 caller", () => {
    if (!isMini) return;
    const v = idx.symbols.find(
      (s) => s.kind === ("InterprocessVariable" as any) && s.name === "aALPAlph1"
    ) as any;
    expect(v).toBeTruthy();
    expect(v.variableType).toBe("Longint");
    expect(callersOf(idx, v).length).toBeGreaterThanOrEqual(1);
  });

  it("aLineItems_Description indexed as ProcessVariable, ≥1 caller", () => {
    if (!isMini) return;
    const v = idx.symbols.find(
      (s) => s.kind === ("ProcessVariable" as any) && s.name === "aLineItems_Description"
    );
    expect(v).toBeTruthy();
    if (v) expect(callersOf(idx, v).length).toBeGreaterThanOrEqual(1);
  });

  // ---------- #DECLARE param signatures captured --------------------------

  it("4DRequestLog_Parse.params has $url:Text and $verbose:Boolean from #DECLARE", () => {
    if (!isMini) return;
    const m = sym("ProjectMethod", "4DRequestLog_Parse") as any;
    expect(m).toBeTruthy();
    expect(m.params).toBeTruthy();
    expect(m.params.length).toBe(2);
    expect(m.params[0]).toEqual({ name: "url", type: "Text" });
    expect(m.params[1]).toEqual({ name: "verbose", type: "Boolean" });
  });

  // ---------- New process / EXECUTE METHOD string forms -------------------

  it("Method_Strings → DispatchedMethod via New process(...) static-string form", () => {
    if (!isMini) return;
    const from = sym("ProjectMethod", "Method_Strings")!;
    const callee = calleesOf(idx, from).find((e) => {
      const t = idx.symbols.find((s) => s.id === e.toId);
      return t && t.name === "DispatchedMethod";
    });
    expect(callee).toBeTruthy();
  });

  it("Method_Strings → EmGetTransaction via EXECUTE METHOD(...) static-string form", () => {
    if (!isMini) return;
    const from = sym("ProjectMethod", "Method_Strings")!;
    const callee = calleesOf(idx, from).find((e) => {
      const t = idx.symbols.find((s) => s.id === e.toId);
      return t && t.name === "EmGetTransaction";
    });
    expect(callee).toBeTruthy();
  });

  // ---------- Formula(...) body recursion ---------------------------------

  it("Formula_Recursion → SomeNested via Formula(...) body extraction", () => {
    if (!isMini) return;
    const from = sym("ProjectMethod", "Formula_Recursion")!;
    const callee = calleesOf(idx, from).find((e) => {
      const t = idx.symbols.find((s) => s.id === e.toId);
      return t && t.name === "SomeNested";
    });
    expect(callee).toBeTruthy();
  });

  // ---------- ds[_Rules].new() chain --------------------------------------

  it("Rules_Test._createActiveRule → RulesEntity (Class) via ds[_Rules].new()", () => {
    // Resolver path: ds[_Rules].new() → strip leading `_` → "Rules" → catalog
    // contains "Rules" → classForTable returns "RulesEntity" → edge to that
    // Class symbol. Locks in the *user-defined-entity* resolution path.
    if (!isMini) return;
    const from = sym("ClassFunction", "_createActiveRule", "Rules_Test");
    expect(from).toBeTruthy();
    const callees = calleesOf(idx, from);
    const newEdge = callees.find((e) => {
      const t = idx.symbols.find((s) => s.id === e.toId);
      return t && t.kind === ("Class" as any) && t.name === "RulesEntity";
    });
    expect(newEdge).toBeTruthy();
  });

  it("Rules_Test._createActiveRule → RulesEntity.save via $eRule.save() chain", () => {
    // $eRule is typed `dsTable:Rules` after the assignment. The chain
    // resolver normalizes that to RulesEntity (via classForTable) and then
    // looks up `save` as a ClassFunction on RulesEntity.
    if (!isMini) return;
    const from = sym("ClassFunction", "_createActiveRule", "Rules_Test");
    if (!from) return;
    const callees = calleesOf(idx, from);
    const saveEdge = callees.find((e) => {
      const t = idx.symbols.find((s) => s.id === e.toId);
      return (
        t &&
        t.kind === ("ClassFunction" as any) &&
        t.name === "save" &&
        (t as any).ownerClass === "RulesEntity"
      );
    });
    expect(saveEdge).toBeTruthy();
  });

  // ---------- Class members ----------------------------------------------

  it("NormalizedOrder.shippingCost ClassGetter exists with ≥1 caller", () => {
    if (!isMini) return;
    const g = sym("ClassGetter", "shippingCost", "NormalizedOrder");
    expect(g).toBeTruthy();
    if (g) expect(callersOf(idx, g).length).toBeGreaterThanOrEqual(1);
  });

  it("NormalizedOrderItem.splitPercentage getter + setter exist + are referenced", () => {
    if (!isMini) return;
    const getter = sym("ClassGetter", "splitPercentage", "NormalizedOrderItem");
    const setter = sym("ClassSetter", "splitPercentage", "NormalizedOrderItem");
    expect(getter).toBeTruthy();
    expect(setter).toBeTruthy();
    if (getter) expect(callersOf(idx, getter).length).toBeGreaterThanOrEqual(1);
    if (setter) expect(callersOf(idx, setter).length).toBeGreaterThanOrEqual(1);
  });

  it("NormalizedOrderItem has a Class constructor", () => {
    if (!isMini) return;
    const ctor = idx.symbols.find(
      (s) =>
        s.kind === ("ClassConstructor" as any) &&
        (s as any).ownerClass === "NormalizedOrderItem"
    );
    expect(ctor).toBeTruthy();
  });

  // ---------- Super / Class extends --------------------------------------

  it("Super_Demo class is marked as extending OrderHydrator", () => {
    if (!isMini) return;
    const cls = idx.symbols.find(
      (s) => s.kind === ("Class" as any) && s.name === "Super_Demo"
    ) as any;
    expect(cls).toBeTruthy();
    expect(cls.extendsClass).toBe("OrderHydrator");
  });

  it("Super_Demo.overrideHydrate → OrderHydrator.getNormalizedInvoiceFromDatastore via Super.X", () => {
    if (!isMini) return;
    const from = sym("ClassFunction", "overrideHydrate", "Super_Demo");
    if (!from) return;
    const callee = calleesOf(idx, from).find((e) => {
      const t = idx.symbols.find((s) => s.id === e.toId);
      return t && t.name === "getNormalizedInvoiceFromDatastore";
    });
    expect(callee).toBeTruthy();
  });

  // ---------- cs.X chain (OrderHydrator_Test) -----------------------------

  it("OrderHydrator_Test → OrderHydrator.getNormalizedInvoiceFromDatastore via cs.X.new().method()", () => {
    if (!isMini) return;
    const from = sym(
      "ClassFunction",
      "test_getNormalizedInvoiceFromDatastore",
      "OrderHydrator_Test"
    );
    expect(from).toBeTruthy();
    if (!from) return;
    const callee = calleesOf(idx, from).find((e) => {
      const t = idx.symbols.find((s) => s.id === e.toId);
      return t && t.name === "getNormalizedInvoiceFromDatastore";
    });
    expect(callee).toBeTruthy();
  });

  // ---------- Compound assignment (This.prop += 1) fans out to get + set --

  it("compound `$item.splitPercentage += 5` fans out to BOTH VarGet (set caller +1) and VarSet (set caller +1)", () => {
    // In NormalizedOrder_Caller.4dm we have `:=75` (1 set) AND `+=5` (1 set
    // + 1 get). So splitPercentage setter has 2 set callers; getter has 1
    // get caller. The += fan-out is what produces the second setter edge
    // and the first getter edge.
    if (!isMini) return;
    const setter = sym("ClassSetter", "splitPercentage", "NormalizedOrderItem");
    expect(setter).toBeTruthy();
    if (setter) expect(callersOf(idx, setter).length).toBeGreaterThanOrEqual(2);
  });

  // ---------- Property declarations captured ------------------------------

  it("Property_Demo class records `property url : Text` in classPropertyTypes", () => {
    if (!isMini) return;
    const cls = sym("Class", "Property_Demo");
    expect(cls).toBeTruthy();
    // Property types live on the file-level parse result, not on the
    // Class symbol — verified indirectly by checking Property_Demo's
    // Class constructor exists and has $url:Text in its param list.
    const ctor = idx.symbols.find(
      (s) =>
        s.kind === ("ClassConstructor" as any) &&
        (s as any).ownerClass === "Property_Demo"
    ) as any;
    expect(ctor).toBeTruthy();
    expect(ctor.params).toBeTruthy();
    expect(ctor.params[0]).toEqual({ name: "url", type: "Text" });
  });

  // ---------- Constants from XLIFF ----------------------------------------

  it("user constants from Constants_Project.xlf are indexed with correct value/type", () => {
    if (!isMini) return;
    const cases: Array<[string, string, string]> = [
      ["_Rules", "Text", "Rules"],
      ["Worker_Backend", "Longint", "1"],
      ["MODULE_INVOICES", "Text", "Invoices"],
      ["4Q_TYPE_AuditCreditCards", "Text", "audit_credit_cards"]
    ];
    for (const [name, type, value] of cases) {
      const c = sym("Constant", name) as any;
      expect(c, name).toBeTruthy();
      expect(c.constantType, name).toBe(type);
      expect(c.constantValue, name).toBe(value);
    }
  });

  // ---------- `return` keyword handling ----------------------------------

  it("Return_Demo emits call edges from `return Foo(...)` expressions without leaking `Return` as a bare-name", () => {
    if (!isMini) return;
    const from = sym("ProjectMethod", "Return_Demo");
    expect(from).toBeTruthy();
    if (!from) return;
    const callees = calleesOf(idx, from);
    const names = new Set(
      callees.map((e) => idx.symbols.find((s) => s.id === e.toId)?.name).filter(Boolean) as string[]
    );
    // Each `return <expr>` form contributes a resolved edge.
    expect(names.has("MyLength")).toBe(true);          // return MyLength("hello")
    expect(names.has("New object")).toBe(true);        // return New object(...)
    expect(names.has("constructor")).toBe(true);       // return cs.Result.new("ok")
    expect(names.has("DispatchedMethod")).toBe(true);  // bare-statement before `return`
    // `Return` must never appear as a callee.
    expect(names.has("Return")).toBe(false);
    expect(names.has("return")).toBe(false);
  });

  // ---------- DatabaseMethod kind ----------------------------------------

  it("DatabaseMethods/onStartup.4dm → DatabaseMethod symbol kind", () => {
    if (!isMini) return;
    const onStartup = idx.symbols.find(
      (s) => s.kind === ("DatabaseMethod" as any) && s.name === "onStartup"
    );
    expect(onStartup).toBeTruthy();
  });
});
