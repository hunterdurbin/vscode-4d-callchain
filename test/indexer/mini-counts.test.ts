import { beforeAll, expect, it } from "vitest";
import { describeWithFixture, resolveFixture } from "../helpers/fixture";
import { getSharedIndex } from "../helpers/sharedIndex";
import type { SymbolIndex } from "../../packages/core/dist";

// These exact-count assertions only make sense against the curated
// mini-fixture. When a developer overrides FOURD_TEST_PROJECT (e.g., to
// run against Symphony), the counts will be different — so we skip this
// suite entirely outside the mini-fixture.
const MINI_FIXTURE_BASENAME = "mini-4d";

describeWithFixture("indexer/mini-counts — deterministic kind tallies", (root) => {
  const isMini = root.endsWith(MINI_FIXTURE_BASENAME);
  let idx: SymbolIndex;

  beforeAll(async () => {
    if (!isMini) return;
    idx = await getSharedIndex(root);
  });

  it("ProjectMethod count is exact", () => {
    if (!isMini) return;
    const count = idx.symbols.filter((s) => s.kind === ("ProjectMethod" as any)).length;
    // 26 + 2 (Subform_Caller, Subform_Helper_Target — fixtures for the
    // EXECUTE METHOD IN SUBFORM ProjectMethod-fallback resolver test in
    // mini-form.test.ts)
    // + 1 (Backtick_Comment_User — fixture for the backtick-comment
    // regression test in edges.test.ts).
    // + 1 (Lint_UsageProbe — fixture for the Phase A linter visitor
    // extensions: localReads, localWrites, localDeclMode, bodySpan.
    // Locked at lint-usage.test.ts).
    expect(count).toBe(30);
  });

  it("Plugin / PluginCommand count is exact (1 bundle, 2 commands from Plugins/PgSQL.bundle)", () => {
    if (!isMini) return;
    expect(idx.symbols.filter((s) => s.kind === ("Plugin" as any)).length).toBe(1);
    const cmds = idx.symbols.filter((s) => s.kind === ("PluginCommand" as any));
    expect(cmds.map((s) => s.name).sort()).toEqual(["PgSQL Connect", "PgSQL Execute"]);
  });

  it("CompilerMethod count is exact (1: Compiler_Variables.4dm)", () => {
    if (!isMini) return;
    const count = idx.symbols.filter((s) => s.kind === ("CompilerMethod" as any)).length;
    expect(count).toBe(1);
  });

  it("Class count is exact", () => {
    if (!isMini) return;
    const count = idx.symbols.filter((s) => s.kind === ("Class" as any)).length;
    expect(count).toBe(15);
  });

  it("ClassFunction count is exact", () => {
    if (!isMini) return;
    const count = idx.symbols.filter((s) => s.kind === ("ClassFunction" as any)).length;
    expect(count).toBe(18);
  });

  it("ClassGetter count is exact", () => {
    if (!isMini) return;
    const count = idx.symbols.filter((s) => s.kind === ("ClassGetter" as any)).length;
    expect(count).toBe(5);
  });

  it("ClassSetter count is exact (1: NormalizedOrderItem.splitPercentage)", () => {
    if (!isMini) return;
    const count = idx.symbols.filter((s) => s.kind === ("ClassSetter" as any)).length;
    expect(count).toBe(1);
  });

  it("ClassConstructor count is exact", () => {
    if (!isMini) return;
    const count = idx.symbols.filter((s) => s.kind === ("ClassConstructor" as any)).length;
    expect(count).toBe(7);
  });

  it("DatabaseMethod count is exact (2: onStartup, onExit)", () => {
    if (!isMini) return;
    const count = idx.symbols.filter((s) => s.kind === ("DatabaseMethod" as any)).length;
    expect(count).toBe(2);
  });

  it("Form / FormMethod / FormObjectMethod count is exact (1 each)", () => {
    if (!isMini) return;
    expect(idx.symbols.filter((s) => s.kind === ("Form" as any)).length).toBe(1);
    expect(idx.symbols.filter((s) => s.kind === ("FormMethod" as any)).length).toBe(1);
    expect(idx.symbols.filter((s) => s.kind === ("FormObjectMethod" as any)).length).toBe(1);
  });

  it("Constant count is exact (5: from Constants_Project.xlf)", () => {
    if (!isMini) return;
    const count = idx.symbols.filter((s) => s.kind === ("Constant" as any)).length;
    expect(count).toBe(5);
  });

  it("InterprocessVariable count is exact (2)", () => {
    if (!isMini) return;
    const count = idx.symbols.filter((s) => s.kind === ("InterprocessVariable" as any)).length;
    expect(count).toBe(2);
  });

  it("ProcessVariable count is exact (3)", () => {
    if (!isMini) return;
    const count = idx.symbols.filter((s) => s.kind === ("ProcessVariable" as any)).length;
    expect(count).toBe(3);
  });

  it("TableBuiltin count is exact (1: ds.Rules.query)", () => {
    // `ds.Rules.new` resolves to the user-defined RulesEntity class so no
    // TableBuiltin is synthesized. `ds.Rules.query` returns an
    // EntitySelection<RulesEntity>, which still flows through the
    // TableBuiltin path because there's no `RulesEntitySelection` user class.
    if (!isMini) return;
    const tb = idx.symbols.filter((s) => s.kind === ("TableBuiltin" as any));
    expect(tb.length).toBe(1);
    expect(tb[0].name).toBe("ds.Rules.query");
  });

  it("Unresolved set is exactly the expected names", () => {
    if (!isMini) return;
    // Locks in the EXACT residual unresolved set. Each entry below is a
    // known parser limitation we accept (so the count never silently drifts):
    //   * `$f.call` — Formula(...) doesn't produce a type token, so the
    //     chained `.call(...)` on the Formula handle can't resolve.
    //   * `IntPhantom_DoesNotExist{2,3}` — intentional unresolved fixtures.
    //     Note: the bare-statement form `IntPhantom_DoesNotExist1` drops
    //     silently per the resolver (ProjectMethodBare hint).
    //   * `EXECUTE_METHOD($methodName)` — `ASSIGN_STRING_LITERAL` uses a
    //     `\x01...\x01` sentinel that cleanLine doesn't produce, so the
    //     dynamic-string EXECUTE METHOD path can't recover the literal.
    //   * `Super` — Super_Demo's parent (OrderHydrator) has no `Class
    //     constructor`, so `Super()` has no resolution target.
    // If a future parser improvement resolves any of these, this test will
    // flag the deletion so we can update the fixture intentionally.
    const names = idx.symbols
      .filter((s) => s.kind === ("Unresolved" as any))
      .map((s) => s.name)
      .sort();
    expect(names).toEqual(
      [
        "$f.call",
        "EXECUTE_METHOD($methodName)",
        "IntPhantom_DoesNotExist2",
        "IntPhantom_DoesNotExist3",
        "Super"
      ].sort()
    );
  });

  it("resolved/total edge ratio is high (~95%)", () => {
    if (!isMini) return;
    const total = idx.edges.length;
    const resolved = idx.edges.filter((e) => e.resolved).length;
    expect(total).toBeGreaterThan(50);
    // Mini-fixture resolves 81/86 = ~94%. Tightened to ≥85% so a future
    // regression that introduces unresolved noise gets caught.
    expect(resolved / total).toBeGreaterThan(0.85);
  });
});

// Sanity helper for ad-hoc debugging:
//   FOURD_TEST_PROJECT=test/fixtures/mini-4d npx vitest run test/indexer/mini-counts
void resolveFixture;
