import { beforeAll, expect, it } from "vitest";
import { describeWithFixture } from "../helpers/fixture";
import { calleesOf, getSharedIndex, symFinder } from "../helpers/sharedIndex";
import type { SymbolIndex } from "../../packages/core/dist";

describeWithFixture("indexer/edges — resolution heuristics", (root) => {
  let idx: SymbolIndex;
  let sym: ReturnType<typeof symFinder>;

  beforeAll(async () => {
    idx = await getSharedIndex(root);
    sym = symFinder(idx);
  });

  it("CALL WORKER with Choose(...) first arg resolves the named worker", () => {
    // Mini-fixture: CallWorker_DynamicFirstArg → CallWorker_Target.
    // Symphony: probably still has AuditCard_New → AuditCard_WS.
    const callerName = sym("ProjectMethod", "CallWorker_DynamicFirstArg")
      ? "CallWorker_DynamicFirstArg"
      : "AuditCard_New";
    const targetName = callerName === "CallWorker_DynamicFirstArg"
      ? "CallWorker_Target"
      : "AuditCard_WS";
    const caller = sym("ProjectMethod", callerName);
    if (!caller) return;
    const callee = calleesOf(idx, caller).find((e) => {
      const t = idx.symbols.find((s) => s.id === e.toId);
      return t && t.name === targetName;
    });
    expect(callee).toBeTruthy();
  });

  it("multi-word builtins do NOT produce phantom bare-name Unresolved edges", () => {
    expect(sym("Unresolved", "RECORD")).toBeFalsy();
  });

  it("bare-name (parenthesis-less) project method calls are linked", () => {
    // Mini-fixture has Bare_ParenLessCalls → _Target1/_Target2.
    // Symphony historically uses WebOrder_Assign → _Assign2/_Assign3.
    const sourceName = sym("ProjectMethod", "Bare_ParenLessCalls")
      ? "Bare_ParenLessCalls"
      : "WebOrder_Assign";
    const [t1, t2] =
      sourceName === "Bare_ParenLessCalls"
        ? ["Bare_ParenLessCalls_Target1", "Bare_ParenLessCalls_Target2"]
        : ["WebOrder_Assign2", "WebOrder_Assign3"];
    const source = sym("ProjectMethod", sourceName);
    if (!source) return;
    const calleeNames = new Set(
      calleesOf(idx, source)
        .map((e) => idx.symbols.find((s) => s.id === e.toId)?.name)
        .filter(Boolean) as string[]
    );
    expect(calleeNames.has(t1)).toBe(true);
    expect(calleeNames.has(t2)).toBe(true);
  });

  it("ds[_Table] bracket access produces a `new`-style edge and a `.save()` chain edge", () => {
    // Either result is acceptable depending on whether the fixture has a
    // user-defined entity class for `Rules`:
    //   * Mini-fixture has RulesEntity → edges go to that Class + its
    //     `save` ClassFunction.
    //   * Symphony (typically) lacks a Rules class → resolver synthesizes
    //     `ds.Rules.new` + `ds.Rules.save` TableBuiltins.
    // Both code paths must produce an edge; this test enforces "some
    // resolution happened" without locking the specific shape.
    const createActiveRule = sym("ClassFunction", "_createActiveRule", "Rules_Test");
    if (!createActiveRule) return;
    const outs = calleesOf(idx, createActiveRule);
    const newEdge = outs.find((e) => {
      const t = idx.symbols.find((s) => s.id === e.toId);
      return (
        t &&
        (t.name === "ds.Rules.new" ||
          ((t.kind === ("Class" as any) || t.kind === ("ClassConstructor" as any)) &&
            /^Rules/i.test(t.name)))
      );
    });
    const saveEdge = outs.find((e) => {
      const t = idx.symbols.find((s) => s.id === e.toId);
      return (
        t &&
        (t.name === "Rules.save" ||
          t.name === "ds.Rules.save" ||
          (t.kind === ("ClassFunction" as any) && t.name === "save"))
      );
    });
    expect(newEdge).toBeTruthy();
    expect(saveEdge).toBeTruthy();
  });
});
