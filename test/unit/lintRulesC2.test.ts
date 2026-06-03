import { describe, expect, it } from "vitest";
import { SymbolKind } from "../../packages/core/dist";
import type {
  CallEdge,
  CallGraph,
  LocalUsageSite,
  ParsedFile,
  SymbolRecord
} from "../../packages/core/dist";

import methodNoCallers from "../../packages/server/dist/lint/rules/unused/methodNoCallers";
import unusedParameter from "../../packages/server/dist/lint/rules/unused/parameter";
import unusedLocal from "../../packages/server/dist/lint/rules/unused/local";

/**
 * Unit-level coverage for Phase C2 rules. Same harness shape as C1 —
 * synthesize a `ParsedFile` (+ a fake `CallGraph` for methodNoCallers)
 * and call `check()` directly. The framework-level path is covered by
 * `test/ide/lint-pipeline.test.ts`.
 */

function makeContext<TOptions>(
  rule: { defaultOptions: TOptions },
  parsed: Partial<ParsedFile>,
  callGraph?: CallGraph
) {
  return {
    uri: "file:///tmp/x.4dm",
    source: "",
    parsed: {
      file: {} as any,
      symbols: [],
      rawCalls: [],
      localTypes: new Map(),
      localStrings: new Map(),
      localReads: new Map(),
      localWrites: new Map(),
      localDeclMode: new Map(),
      ...parsed
    } as ParsedFile,
    callGraph,
    options: rule.defaultOptions
  };
}

const SAMPLE_LOC = { uri: "file:///tmp/x.4dm", line: 0, column: 9, endColumn: 14 };

/** Minimal CallGraph stub — only `.callers(id)` is used by the rule. */
function fakeGraph(callerMap: Record<string, CallEdge[]>): CallGraph {
  return {
    callers: (id: string) => callerMap[id] ?? []
  } as unknown as CallGraph;
}

describe("unused/method-no-callers", () => {
  it("flags a project method with zero callers", () => {
    const orphan: SymbolRecord = {
      id: "ProjectMethod:Orphan",
      name: "Orphan",
      kind: SymbolKind.ProjectMethod,
      location: { uri: "file:///tmp/x.4dm", line: 0 }
    };
    const findings = methodNoCallers.check(
      makeContext(methodNoCallers, { symbols: [orphan] }, fakeGraph({}))
    );
    expect(findings.map((f) => f.message)).toEqual([
      "Project method 'Orphan' has no callers."
    ]);
  });

  it("does NOT flag a method with at least one caller", () => {
    const called: SymbolRecord = {
      id: "ProjectMethod:Called",
      name: "Called",
      kind: SymbolKind.ProjectMethod,
      location: SAMPLE_LOC
    };
    const edge: CallEdge = {
      fromId: "ProjectMethod:Other",
      toId: "ProjectMethod:Called",
      callKind: "Static" as any,
      line: 0,
      raw: "",
      resolved: true
    };
    const findings = methodNoCallers.check(
      makeContext(
        methodNoCallers,
        { symbols: [called] },
        fakeGraph({ "ProjectMethod:Called": [edge] })
      )
    );
    expect(findings).toHaveLength(0);
  });

  it("skips names matched by the default entrypointPattern (^On )", () => {
    const event: SymbolRecord = {
      id: "ProjectMethod:On Startup",
      name: "On Startup",
      kind: SymbolKind.ProjectMethod,
      location: SAMPLE_LOC
    };
    const findings = methodNoCallers.check(
      makeContext(methodNoCallers, { symbols: [event] }, fakeGraph({}))
    );
    expect(findings).toHaveLength(0);
  });

  it("honors the explicit entrypoints allowlist", () => {
    const rpc: SymbolRecord = {
      id: "ProjectMethod:HandleHttpRequest",
      name: "HandleHttpRequest",
      kind: SymbolKind.ProjectMethod,
      location: SAMPLE_LOC
    };
    const ctx = makeContext(methodNoCallers, { symbols: [rpc] }, fakeGraph({}));
    ctx.options = {
      publicPattern: "^[^_]",
      entrypoints: ["HandleHttpRequest"],
      entrypointPattern: "^On "
    };
    expect(methodNoCallers.check(ctx)).toHaveLength(0);
  });

  it("publicPattern can broaden / narrow which symbols are checked", () => {
    const priv: SymbolRecord = {
      id: "ProjectMethod:_internal",
      name: "_internal",
      kind: SymbolKind.ProjectMethod,
      location: SAMPLE_LOC
    };
    // Default `^[^_]` excludes `_internal`.
    const defaults = methodNoCallers.check(
      makeContext(methodNoCallers, { symbols: [priv] }, fakeGraph({}))
    );
    expect(defaults).toHaveLength(0);
    // Loosening publicPattern to `.` checks everything.
    const ctx = makeContext(methodNoCallers, { symbols: [priv] }, fakeGraph({}));
    ctx.options = { publicPattern: ".", entrypoints: [], entrypointPattern: "^On " };
    expect(methodNoCallers.check(ctx)).toHaveLength(1);
  });

  it("returns nothing when callGraph is unavailable (cold load)", () => {
    const orphan: SymbolRecord = {
      id: "ProjectMethod:Orphan",
      name: "Orphan",
      kind: SymbolKind.ProjectMethod,
      location: SAMPLE_LOC
    };
    const ctx = makeContext(methodNoCallers, { symbols: [orphan] }, undefined);
    expect(methodNoCallers.check(ctx)).toHaveLength(0);
  });
});

describe("unused/parameter", () => {
  it("flags params that don't appear in localReads", () => {
    const sym: SymbolRecord = {
      id: "ClassFunction:Foo.bar",
      name: "bar",
      kind: SymbolKind.ClassFunction,
      location: SAMPLE_LOC,
      params: [
        { name: "used", type: "Text" },
        { name: "unused", type: "Text" }
      ]
    };
    const reads = new Map<string, LocalUsageSite[]>([
      ["used", [{ line: 1, column: 0, endColumn: 4 }]]
    ]);
    const findings = unusedParameter.check(
      makeContext(unusedParameter, {
        symbols: [sym],
        localReads: new Map([[sym.id, reads]])
      })
    );
    expect(findings.map((f) => f.message)).toEqual([
      "Parameter '$unused' is declared but never read."
    ]);
  });

  it("default ^_ ignore lets `$_unused` pass", () => {
    const sym: SymbolRecord = {
      id: "ClassFunction:Foo.bar",
      name: "bar",
      kind: SymbolKind.ClassFunction,
      location: SAMPLE_LOC,
      params: [{ name: "_unused", type: "Text" }]
    };
    const findings = unusedParameter.check(
      makeContext(unusedParameter, {
        symbols: [sym],
        localReads: new Map([[sym.id, new Map()]])
      })
    );
    expect(findings).toHaveLength(0);
  });

  it("ignores parameter-less symbols quietly", () => {
    const sym: SymbolRecord = {
      id: "ClassGetter:Foo.prop",
      name: "prop",
      kind: SymbolKind.ClassGetter,
      location: SAMPLE_LOC
    };
    const findings = unusedParameter.check(
      makeContext(unusedParameter, { symbols: [sym] })
    );
    expect(findings).toHaveLength(0);
  });
});

describe("unused/local", () => {
  function siteAt(line: number, col: number, endCol: number): LocalUsageSite {
    return { line, column: col, endColumn: endCol };
  }

  it("flags names in localWrites with no corresponding localReads entry", () => {
    const symId = "ProjectMethod:Probe";
    const writes = new Map<string, LocalUsageSite[]>([
      ["dead", [siteAt(2, 0, 5)]],
      ["used", [siteAt(3, 0, 5)]]
    ]);
    const reads = new Map<string, LocalUsageSite[]>([
      ["used", [siteAt(4, 5, 10)]]
    ]);
    const findings = unusedLocal.check(
      makeContext(unusedLocal, {
        localWrites: new Map([[symId, writes]]),
        localReads: new Map([[symId, reads]])
      })
    );
    expect(findings.map((f) => f.message)).toEqual([
      "Local variable '$dead' is assigned but never read."
    ]);
    expect(findings[0].range.start).toEqual({ line: 2, character: 0 });
  });

  it("default ^_ ignore exempts placeholder names", () => {
    const symId = "ProjectMethod:Probe";
    const writes = new Map<string, LocalUsageSite[]>([
      ["_throwaway", [siteAt(0, 0, 11)]]
    ]);
    const findings = unusedLocal.check(
      makeContext(unusedLocal, {
        localWrites: new Map([[symId, writes]])
      })
    );
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag locals that are both written and read", () => {
    const symId = "ProjectMethod:Probe";
    const writes = new Map<string, LocalUsageSite[]>([
      ["x", [siteAt(0, 0, 2)]]
    ]);
    const reads = new Map<string, LocalUsageSite[]>([
      ["x", [siteAt(1, 0, 2)]]
    ]);
    const findings = unusedLocal.check(
      makeContext(unusedLocal, {
        localWrites: new Map([[symId, writes]]),
        localReads: new Map([[symId, reads]])
      })
    );
    expect(findings).toHaveLength(0);
  });
});
