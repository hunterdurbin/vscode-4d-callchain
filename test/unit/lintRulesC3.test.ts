import { describe, expect, it } from "vitest";
import { SymbolKind } from "../../packages/core/dist";
import type { ParsedFile, SymbolRecord } from "../../packages/core/dist";

import classPascalCase from "../../packages/server/dist/lint/rules/style/classPascalCase";
import methodCamelCase from "../../packages/server/dist/lint/rules/style/methodCamelCase";
import missingDocstring from "../../packages/server/dist/lint/rules/style/missingDocstring";
import builtinNameCollision from "../../packages/server/dist/lint/rules/style/builtinNameCollision";

function makeContext<TOptions>(
  rule: { defaultOptions: TOptions },
  parsed: Partial<ParsedFile>,
  source = ""
) {
  return {
    uri: "file:///tmp/x.4dm",
    source,
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

const LOC = { uri: "file:///tmp/x.4dm", line: 5, column: 9, endColumn: 14 };

describe("style/class-pascal-case", () => {
  it("flags class names not matching the default PascalCase regex", () => {
    const bad: SymbolRecord = {
      id: "Class:my_helper",
      name: "my_helper",
      kind: SymbolKind.Class,
      location: LOC
    };
    const good: SymbolRecord = {
      id: "Class:MyClass",
      name: "MyClass",
      kind: SymbolKind.Class,
      location: LOC
    };
    const findings = classPascalCase.check(
      makeContext(classPascalCase, { symbols: [bad, good] })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("'my_helper'");
  });

  it("ignores non-Class symbols", () => {
    const fn: SymbolRecord = {
      id: "ClassFunction:Foo.bar",
      name: "bar",
      kind: SymbolKind.ClassFunction,
      location: LOC
    };
    expect(
      classPascalCase.check(makeContext(classPascalCase, { symbols: [fn] }))
    ).toHaveLength(0);
  });

  it("honors a custom pattern", () => {
    const sym: SymbolRecord = {
      id: "Class:my_helper",
      name: "my_helper",
      kind: SymbolKind.Class,
      location: LOC
    };
    const ctx = makeContext(classPascalCase, { symbols: [sym] });
    ctx.options = { pattern: "^[a-z][a-z_]*$" };
    expect(classPascalCase.check(ctx)).toHaveLength(0);
  });
});

describe("style/method-camel-case", () => {
  it("flags methods not matching default camelCase", () => {
    const bad: SymbolRecord = {
      id: "ClassFunction:Foo.MyMethod",
      name: "MyMethod",
      kind: SymbolKind.ClassFunction,
      location: LOC
    };
    const findings = methodCamelCase.check(
      makeContext(methodCamelCase, { symbols: [bad] })
    );
    expect(findings).toHaveLength(1);
  });

  it("allows underscore prefix by default", () => {
    const priv: SymbolRecord = {
      id: "ClassFunction:Foo._privateName",
      name: "_privateName",
      kind: SymbolKind.ClassFunction,
      location: LOC
    };
    expect(
      methodCamelCase.check(makeContext(methodCamelCase, { symbols: [priv] }))
    ).toHaveLength(0);
  });

  it("flags underscore-prefixed names when allowUnderscorePrefix=false", () => {
    const priv: SymbolRecord = {
      id: "ClassFunction:Foo._privateName",
      name: "_privateName",
      kind: SymbolKind.ClassFunction,
      location: LOC
    };
    const ctx = methodCamelCase.defaultOptions.allowUnderscorePrefix
      ? (() => {
          const c = makeContext(methodCamelCase, { symbols: [priv] });
          c.options = {
            pattern: "^[a-z][A-Za-z0-9_]*$",
            allowUnderscorePrefix: false
          };
          return c;
        })()
      : makeContext(methodCamelCase, { symbols: [priv] });
    expect(methodCamelCase.check(ctx)).toHaveLength(1);
  });

  it("skips constructors / getters / setters (they have other rules)", () => {
    const ctor: SymbolRecord = {
      id: "ClassConstructor:Foo.constructor",
      name: "constructor",
      kind: SymbolKind.ClassConstructor,
      location: LOC
    };
    expect(
      methodCamelCase.check(makeContext(methodCamelCase, { symbols: [ctor] }))
    ).toHaveLength(0);
  });
});

describe("style/missing-docstring-on-public", () => {
  function classFn(name: string, declLine: number): SymbolRecord {
    return {
      id: `ClassFunction:Foo.${name}`,
      name,
      kind: SymbolKind.ClassFunction,
      ownerClass: "Foo",
      location: { uri: "file:///tmp/x.4dm", line: declLine, column: 9, endColumn: 9 + name.length },
      bodySpan: { startLine: declLine, endLine: declLine + 3 }
    };
  }

  it("flags a public class function with no leading comments", () => {
    const sym = classFn("doStuff", 3);
    const source = [
      "Class Foo",                       // 0
      "",                                // 1
      "",                                // 2
      "Function doStuff() : Text",       // 3
      "  return \"\"",                   // 4
      "End function"                     // 5
    ].join("\n");
    const findings = missingDocstring.check(
      makeContext(missingDocstring, { symbols: [sym] }, source)
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("'doStuff'");
  });

  it("accepts a `//` comment immediately above the declaration", () => {
    const sym = classFn("doStuff", 4);
    const source = [
      "Class Foo",                        // 0
      "",                                 // 1
      "",                                 // 2
      "// Does the stuff.",               // 3
      "Function doStuff() : Text",        // 4
      "  return \"\"",                    // 5
      "End function"                      // 6
    ].join("\n");
    const findings = missingDocstring.check(
      makeContext(missingDocstring, { symbols: [sym] }, source)
    );
    expect(findings).toHaveLength(0);
  });

  it("accepts a backtick (4D v18+) comment", () => {
    const sym = classFn("doStuff", 4);
    const source = [
      "Class Foo",                        // 0
      "",                                 // 1
      "",                                 // 2
      "` Does the stuff.",                // 3
      "Function doStuff() : Text",        // 4
      "  return \"\"",                    // 5
      "End function"                      // 6
    ].join("\n");
    expect(
      missingDocstring.check(
        makeContext(missingDocstring, { symbols: [sym] }, source)
      )
    ).toHaveLength(0);
  });

  it("a blank line between comment and decl breaks the leading-block", () => {
    const sym = classFn("doStuff", 5);
    const source = [
      "Class Foo",                        // 0
      "",                                 // 1
      "// abandoned docstring",           // 2
      "",                                 // 3
      "",                                 // 4
      "Function doStuff() : Text",        // 5
      "  return \"\"",                    // 6
      "End function"                      // 7
    ].join("\n");
    const findings = missingDocstring.check(
      makeContext(missingDocstring, { symbols: [sym] }, source)
    );
    expect(findings).toHaveLength(1);
  });

  it("skips underscore-prefixed (non-public) names", () => {
    const sym = classFn("_privateBits", 3);
    const source = [
      "Class Foo",                        // 0
      "",                                 // 1
      "",                                 // 2
      "Function _privateBits() : Text",   // 3
      "  return \"\"",                    // 4
      "End function"                      // 5
    ].join("\n");
    expect(
      missingDocstring.check(
        makeContext(missingDocstring, { symbols: [sym] }, source)
      )
    ).toHaveLength(0);
  });

  it("skips when bodySpan.startLine is 0 (file-level project method)", () => {
    const sym: SymbolRecord = {
      id: "ProjectMethod:Foo",
      name: "Foo",
      kind: SymbolKind.ProjectMethod,
      location: { uri: "file:///tmp/x.4dm", line: 0 },
      bodySpan: { startLine: 0, endLine: 20 }
    };
    const findings = missingDocstring.check(
      makeContext(missingDocstring, { symbols: [sym] }, "")
    );
    expect(findings).toHaveLength(0);
  });
});

describe("style/builtin-name-collision", () => {
  it("flags a project method named like a 4D builtin (case-insensitive)", () => {
    const collision: SymbolRecord = {
      id: "ProjectMethod:length",
      name: "length",
      kind: SymbolKind.ProjectMethod,
      location: LOC
    };
    const findings = builtinNameCollision.check(
      makeContext(builtinNameCollision, { symbols: [collision] })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("'length'");
  });

  it("allows the user to allowlist intentional collisions", () => {
    const collision: SymbolRecord = {
      id: "ProjectMethod:Length",
      name: "Length",
      kind: SymbolKind.ProjectMethod,
      location: LOC
    };
    const ctx = makeContext(builtinNameCollision, { symbols: [collision] });
    ctx.options = { ignoreNames: ["Length"] };
    expect(builtinNameCollision.check(ctx)).toHaveLength(0);
  });

  it("ignores names that don't collide with any builtin", () => {
    const sym: SymbolRecord = {
      id: "ProjectMethod:MyTotallyOriginalName",
      name: "MyTotallyOriginalName",
      kind: SymbolKind.ProjectMethod,
      location: LOC
    };
    expect(
      builtinNameCollision.check(
        makeContext(builtinNameCollision, { symbols: [sym] })
      )
    ).toHaveLength(0);
  });
});
