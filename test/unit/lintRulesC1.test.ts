import { describe, expect, it } from "vitest";
import { SymbolKind } from "../../packages/core/dist";
import type {
  LocalUsageSite,
  ParsedFile,
  SymbolRecord
} from "../../packages/core/dist";

import missingParamType from "../../packages/server/dist/lint/rules/types/missingParamType";
import missingReturnType from "../../packages/server/dist/lint/rules/types/missingReturnType";
import implicitLocal from "../../packages/server/dist/lint/rules/decl/implicitLocal";

/**
 * Unit-level coverage for Phase C1 rules. Each rule's `check()` is invoked
 * against a synthetic `ParsedFile` so the assertions live next to the rule
 * logic and don't need the fixture/index pipeline. The Phase B LSP test
 * already proves the framework end-to-end.
 */

function makeContext<TOptions>(rule: { defaultOptions: TOptions }, parsed: Partial<ParsedFile>) {
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
    callGraph: undefined,
    options: rule.defaultOptions
  };
}

const SAMPLE_LOC = { uri: "file:///tmp/x.4dm", line: 3, column: 9, endColumn: 14 };

describe("types/missing-param-type", () => {
  it("flags each param without a declared type", () => {
    const sym: SymbolRecord = {
      id: "ClassFunction:Foo.bar",
      name: "bar",
      kind: SymbolKind.ClassFunction,
      ownerClass: "Foo",
      location: SAMPLE_LOC,
      params: [{ name: "a", type: "Text" }, { name: "b" }, { name: "c" }]
    };
    const findings = missingParamType.check(
      makeContext(missingParamType, { symbols: [sym] })
    );
    expect(findings.map((f) => f.message)).toEqual([
      "Parameter '$b' has no declared type.",
      "Parameter '$c' has no declared type."
    ]);
  });

  it("skips underscore-prefixed param names (intentional placeholders)", () => {
    const sym: SymbolRecord = {
      id: "ClassFunction:Foo.bar",
      name: "bar",
      kind: SymbolKind.ClassFunction,
      location: SAMPLE_LOC,
      params: [{ name: "_placeholder" }]
    };
    const findings = missingParamType.check(
      makeContext(missingParamType, { symbols: [sym] })
    );
    expect(findings).toHaveLength(0);
  });

  it("ignores non-callable symbol kinds (Class, Form, Constant, …)", () => {
    const sym: SymbolRecord = {
      id: "Class:Foo",
      name: "Foo",
      kind: SymbolKind.Class,
      location: SAMPLE_LOC,
      params: [{ name: "ignored" }] as any // synthetic — Class never has params
    };
    const findings = missingParamType.check(
      makeContext(missingParamType, { symbols: [sym] })
    );
    expect(findings).toHaveLength(0);
  });

  it("returns nothing when parsed is undefined", () => {
    const ctx: any = {
      uri: "file:///tmp/x.4dm",
      source: "",
      parsed: undefined,
      callGraph: undefined,
      options: missingParamType.defaultOptions
    };
    expect(missingParamType.check(ctx)).toHaveLength(0);
  });
});

describe("types/missing-return-type", () => {
  it("flags class functions without a return type", () => {
    const sym: SymbolRecord = {
      id: "ClassFunction:Foo.bar",
      name: "bar",
      kind: SymbolKind.ClassFunction,
      location: SAMPLE_LOC
      // no returnType
    };
    const findings = missingReturnType.check(
      makeContext(missingReturnType, { symbols: [sym] })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toBe("Function 'bar' has no declared return type.");
  });

  it("flags class getters without a return type", () => {
    const sym: SymbolRecord = {
      id: "ClassGetter:Foo.prop",
      name: "prop",
      kind: SymbolKind.ClassGetter,
      location: SAMPLE_LOC
    };
    const findings = missingReturnType.check(
      makeContext(missingReturnType, { symbols: [sym] })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toBe("Getter 'prop' has no declared return type.");
  });

  it("skips constructors and setters (no return slot)", () => {
    const ctor: SymbolRecord = {
      id: "ClassConstructor:Foo.constructor",
      name: "constructor",
      kind: SymbolKind.ClassConstructor,
      location: SAMPLE_LOC
    };
    const setter: SymbolRecord = {
      id: "ClassSetter:Foo.prop",
      name: "prop",
      kind: SymbolKind.ClassSetter,
      location: SAMPLE_LOC
    };
    const findings = missingReturnType.check(
      makeContext(missingReturnType, { symbols: [ctor, setter] })
    );
    expect(findings).toHaveLength(0);
  });

  it("does NOT flag declarations that have a return type", () => {
    const sym: SymbolRecord = {
      id: "ClassFunction:Foo.bar",
      name: "bar",
      kind: SymbolKind.ClassFunction,
      location: SAMPLE_LOC,
      returnType: "Text"
    };
    const findings = missingReturnType.check(
      makeContext(missingReturnType, { symbols: [sym] })
    );
    expect(findings).toHaveLength(0);
  });
});

describe("decl/implicit-local", () => {
  function siteAt(line: number, col: number, endCol: number): LocalUsageSite {
    return { line, column: col, endColumn: endCol };
  }

  it("flags every name marked 'implicit' and squiggles its first write site", () => {
    const symId = "ProjectMethod:Probe";
    const declMode = new Map([
      ["impl", "implicit" as const],
      ["explicit", "declared" as const]
    ]);
    const writes = new Map<string, LocalUsageSite[]>([
      ["impl", [siteAt(4, 0, 5)]],
      ["explicit", [siteAt(5, 0, 9)]]
    ]);
    const findings = implicitLocal.check(
      makeContext(implicitLocal, {
        localDeclMode: new Map([[symId, declMode]]),
        localWrites: new Map([[symId, writes]])
      })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toBe(
      "Local variable '$impl' is used without a prior 'var', 'C_*', or '#DECLARE' declaration."
    );
    expect(findings[0].range.start).toEqual({ line: 4, character: 0 });
    expect(findings[0].range.end).toEqual({ line: 4, character: 5 });
  });

  it("honors ignoreNamePattern (defaults to ^_)", () => {
    const symId = "ProjectMethod:Probe";
    const declMode = new Map([
      ["_tmp", "implicit" as const],
      ["real", "implicit" as const]
    ]);
    const writes = new Map<string, LocalUsageSite[]>([
      ["_tmp", [siteAt(1, 0, 4)]],
      ["real", [siteAt(2, 0, 4)]]
    ]);
    const findings = implicitLocal.check(
      makeContext(implicitLocal, {
        localDeclMode: new Map([[symId, declMode]]),
        localWrites: new Map([[symId, writes]])
      })
    );
    expect(findings.map((f) => f.message)).toEqual([
      "Local variable '$real' is used without a prior 'var', 'C_*', or '#DECLARE' declaration."
    ]);
  });

  it("honors a user-supplied ignore pattern", () => {
    const symId = "ProjectMethod:Probe";
    const declMode = new Map([
      ["foo_temp", "implicit" as const],
      ["bar", "implicit" as const]
    ]);
    const writes = new Map<string, LocalUsageSite[]>([
      ["foo_temp", [siteAt(0, 0, 8)]],
      ["bar", [siteAt(1, 0, 3)]]
    ]);
    const ctx = makeContext(implicitLocal, {
      localDeclMode: new Map([[symId, declMode]]),
      localWrites: new Map([[symId, writes]])
    });
    ctx.options = { ignoreNamePattern: "_temp$" };
    const findings = implicitLocal.check(ctx);
    expect(findings.map((f) => f.message)).toEqual([
      "Local variable '$bar' is used without a prior 'var', 'C_*', or '#DECLARE' declaration."
    ]);
  });

  it("falls back gracefully when ignoreNamePattern is an invalid regex", () => {
    const symId = "ProjectMethod:Probe";
    const declMode = new Map([["impl", "implicit" as const]]);
    const writes = new Map<string, LocalUsageSite[]>([
      ["impl", [siteAt(0, 0, 4)]]
    ]);
    const ctx = makeContext(implicitLocal, {
      localDeclMode: new Map([[symId, declMode]]),
      localWrites: new Map([[symId, writes]])
    });
    ctx.options = { ignoreNamePattern: "(unterminated" };
    const findings = implicitLocal.check(ctx);
    // Bad regex → safeRegex returns null → no name is ignored, so $impl
    // still fires.
    expect(findings).toHaveLength(1);
  });
});
