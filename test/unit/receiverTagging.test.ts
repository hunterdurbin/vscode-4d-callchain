import { describe, expect, it } from "vitest";
import { SymbolKind, ClassFlavor } from "../../packages/core/dist";
import type { SymbolRecord, CallEdge, RawCallSite } from "../../packages/core/dist";

const nameResolver = require("../../packages/core/dist/indexer/nameResolver");

// Locks the CallEdge.receiver tag emitted by the resolver for This./Super.
// references — the Method Trace's dispatch re-resolution depends on it.

function classSym(name: string, extendsClass?: string): SymbolRecord {
  return {
    id: `Class:${name}`,
    name,
    kind: SymbolKind.Class,
    location: { uri: `file:///Classes/${name}.4dm`, line: 0 },
    ...(extendsClass ? { extendsClass } : {})
  };
}

function memberSym(owner: string, name: string, kind: SymbolKind): SymbolRecord {
  return {
    id: `${kind}:${owner}.${name}`,
    name,
    kind,
    ownerClass: owner,
    location: { uri: `file:///Classes/${owner}.4dm`, line: 1 }
  };
}

function call(fromSymbolId: string, hint: RawCallSite["hint"], line = 1): RawCallSite {
  return { fromSymbolId, line, raw: "x", expression: "x", hint };
}

/** Run the resolver over one synthetic class file. */
function resolveClassFile(opts: {
  className: string;
  extendsClass?: string;
  symbols: SymbolRecord[];
  rawCalls: RawCallSite[];
}): CallEdge[] {
  const parsed = {
    file: {
      absolutePath: `/p/Project/Sources/Classes/${opts.className}.4dm`,
      relativePath: `Project/Sources/Classes/${opts.className}.4dm`,
      category: "class"
    },
    symbols: opts.symbols.filter((s) => s.location.uri.includes(`/${opts.className}.4dm`)),
    rawCalls: opts.rawCalls,
    localTypes: new Map(),
    localStrings: new Map(),
    classInfo: {
      name: opts.className,
      extends: opts.extendsClass,
      flavor: ClassFlavor.Generic
    }
  };
  const out = nameResolver.resolve(
    { files: [parsed], plugins: [], catalogTables: new Set() },
    opts.symbols
  );
  return out.edges;
}

const HIERARCHY = [
  classSym("Animal"),
  classSym("Dog", "Animal"),
  memberSym("Animal", "template", SymbolKind.ClassFunction),
  memberSym("Animal", "hook", SymbolKind.ClassFunction),
  memberSym("Dog", "run", SymbolKind.ClassFunction),
  memberSym("Animal", "label", SymbolKind.ClassGetter),
  memberSym("Animal", "label", SymbolKind.ClassSetter),
  memberSym("Animal", "counter", SymbolKind.ClassProperty)
];

describe("resolver receiver tagging", () => {
  it("tags This.fn() with receiver 'this' (own and inherited)", () => {
    const edges = resolveClassFile({
      className: "Dog",
      extendsClass: "Animal",
      symbols: HIERARCHY,
      rawCalls: [call("ClassFunction:Dog.run", { kind: "ThisCall", method: "template" })]
    });
    const e = edges.find((x) => x.toId === "ClassFunction:Animal.template");
    expect(e?.receiver).toBe("this");
    expect(e?.resolved).toBe(true);
  });

  it("tags the Unresolved This.<x> fallback with receiver 'this'", () => {
    const edges = resolveClassFile({
      className: "Dog",
      extendsClass: "Animal",
      symbols: HIERARCHY,
      rawCalls: [call("ClassFunction:Dog.run", { kind: "ThisCall", method: "missingHook" })]
    });
    const e = edges.find((x) => x.toId === "Unresolved:This.missingHook");
    expect(e).toBeTruthy();
    expect(e?.receiver).toBe("this");
    expect(e?.resolved).toBe(false);
  });

  it("tags Super.fn() with receiver 'super'", () => {
    const edges = resolveClassFile({
      className: "Dog",
      extendsClass: "Animal",
      symbols: HIERARCHY,
      rawCalls: [call("ClassFunction:Dog.run", { kind: "SuperCall", method: "hook" })]
    });
    const e = edges.find((x) => x.toId === "ClassFunction:Animal.hook");
    expect(e?.receiver).toBe("super");
  });

  it("tags This.prop reads and writes with receiver 'this' (getter/setter/property)", () => {
    const edges = resolveClassFile({
      className: "Dog",
      extendsClass: "Animal",
      symbols: HIERARCHY,
      rawCalls: [
        call("ClassFunction:Dog.run", { kind: "ThisGet", property: "label" }, 1),
        call("ClassFunction:Dog.run", { kind: "ThisSet", property: "label" }, 2),
        call("ClassFunction:Dog.run", { kind: "ThisGet", property: "counter" }, 3),
        call("ClassFunction:Dog.run", { kind: "ThisSet", property: "counter" }, 4)
      ]
    });
    const tagged = edges.filter((x) => x.receiver === "this");
    expect(tagged.map((x) => [x.toId, x.access])).toEqual([
      ["ClassGetter:Animal.label", "read"],
      ["ClassSetter:Animal.label", "write"],
      ["ClassProperty:Animal.counter", "read"],
      ["ClassProperty:Animal.counter", "write"]
    ]);
  });

  it("does NOT tag chained receivers (This.prop.fn()) or bare calls", () => {
    const projectMethod: SymbolRecord = {
      id: "ProjectMethod:DoWork",
      name: "DoWork",
      kind: SymbolKind.ProjectMethod,
      location: { uri: "file:///Methods/DoWork.4dm", line: 0 }
    };
    const edges = resolveClassFile({
      className: "Dog",
      extendsClass: "Animal",
      symbols: [...HIERARCHY, projectMethod],
      rawCalls: [
        call(
          "ClassFunction:Dog.run",
          { kind: "ThisChainCall", path: [{ name: "counter", isCall: false }], method: "push" },
          1
        ),
        call("ClassFunction:Dog.run", { kind: "BareName", name: "DoWork" }, 2)
      ]
    });
    for (const e of edges) {
      expect(e.receiver).toBeUndefined();
    }
  });

  it("tags receiverClass on $var calls with the variable's class, even for inherited members", () => {
    const parsed = {
      file: {
        absolutePath: "/p/Project/Sources/Classes/Dog.4dm",
        relativePath: "Project/Sources/Classes/Dog.4dm",
        category: "class"
      },
      symbols: HIERARCHY.filter((s) => s.location.uri.includes("/Dog.4dm")),
      rawCalls: [call("ClassFunction:Dog.run", { kind: "VarCall", variable: "dog", method: "template" })],
      localTypes: new Map([["ClassFunction:Dog.run", new Map([["dog", "cs.Dog"]])]]),
      localStrings: new Map(),
      classInfo: { name: "Dog", extends: "Animal", flavor: ClassFlavor.Generic }
    };
    const out = nameResolver.resolve(
      { files: [parsed], plugins: [], catalogTables: new Set() },
      HIERARCHY
    );
    // template is declared on Animal — the edge targets Animal.template but
    // carries the variable's class so trace UIs can pin Dog.
    const e = out.edges.find((x: CallEdge) => x.toId === "ClassFunction:Animal.template");
    expect(e).toBeTruthy();
    expect(e!.receiverClass).toBe("Dog");
    expect(e!.receiver).toBeUndefined();
  });

  it("tags receiverClass on cs.X.new() and cs.X.fn() with the named class", () => {
    const edges = resolveClassFile({
      className: "Dog",
      extendsClass: "Animal",
      symbols: HIERARCHY,
      rawCalls: [
        call("ClassFunction:Dog.run", { kind: "CsNew", className: "Dog" }, 1),
        call("ClassFunction:Dog.run", { kind: "CsCall", className: "Dog", method: "template" }, 2)
      ]
    });
    // No Dog constructor exists → the CsNew edge falls back to the Class symbol.
    const ctor = edges.find((x) => x.toId === "Class:Dog");
    expect(ctor?.receiverClass).toBe("Dog");
    // template is inherited from Animal — receiverClass still Dog.
    const fn = edges.find((x) => x.toId === "ClassFunction:Animal.template");
    expect(fn?.receiverClass).toBe("Dog");
  });

  it("tags receiverClass on cs.Dog.new().run() chains (construction + terminal)", () => {
    const edges = resolveClassFile({
      className: "Dog",
      extendsClass: "Animal",
      symbols: HIERARCHY,
      rawCalls: [
        call("ClassFunction:Dog.run", { kind: "CsChainCall", className: "Dog", path: [], method: "template" })
      ]
    });
    // Construction edge: no Dog constructor → falls back to the Class symbol.
    const ctor = edges.find((x) => x.toId === "Class:Dog");
    expect(ctor?.receiverClass).toBe("Dog");
    // Terminal method: template is inherited from Animal — still tagged Dog.
    const fn = edges.find((x) => x.toId === "ClassFunction:Animal.template");
    expect(fn).toBeTruthy();
    expect(fn!.receiverClass).toBe("Dog");
  });

  it("tags receiverClass on $var property reads/writes with the variable's class", () => {
    const parsed = {
      file: {
        absolutePath: "/p/Project/Sources/Classes/Dog.4dm",
        relativePath: "Project/Sources/Classes/Dog.4dm",
        category: "class"
      },
      symbols: HIERARCHY.filter((s) => s.location.uri.includes("/Dog.4dm")),
      rawCalls: [
        call("ClassFunction:Dog.run", { kind: "VarGet", variable: "dog", property: "label" }, 1),
        call("ClassFunction:Dog.run", { kind: "VarSet", variable: "dog", property: "label" }, 2)
      ],
      localTypes: new Map([["ClassFunction:Dog.run", new Map([["dog", "cs.Dog"]])]]),
      localStrings: new Map(),
      classInfo: { name: "Dog", extends: "Animal", flavor: ClassFlavor.Generic }
    };
    const out = nameResolver.resolve(
      { files: [parsed], plugins: [], catalogTables: new Set() },
      HIERARCHY
    );
    const read = out.edges.find((x: CallEdge) => x.toId === "ClassGetter:Animal.label");
    const write = out.edges.find((x: CallEdge) => x.toId === "ClassSetter:Animal.label");
    expect(read?.receiverClass).toBe("Dog");
    expect(write?.receiverClass).toBe("Dog");
  });

  it("does NOT tag the flavored-builtin fallback (This.save on an Entity class)", () => {
    const entityClass: SymbolRecord = {
      ...classSym("OrderEntity"),
      classFlavor: ClassFlavor.Entity
    };
    const fn = memberSym("OrderEntity", "validate", SymbolKind.ClassFunction);
    const parsedSymbols = [entityClass, fn];
    const parsed = {
      file: {
        absolutePath: "/p/Project/Sources/Classes/OrderEntity.4dm",
        relativePath: "Project/Sources/Classes/OrderEntity.4dm",
        category: "class"
      },
      symbols: parsedSymbols,
      rawCalls: [call("ClassFunction:OrderEntity.validate", { kind: "ThisCall", method: "save" })],
      localTypes: new Map(),
      localStrings: new Map(),
      classInfo: { name: "OrderEntity", flavor: ClassFlavor.Entity }
    };
    const out = nameResolver.resolve(
      { files: [parsed], plugins: [], catalogTables: new Set() },
      parsedSymbols
    );
    const e = out.edges.find((x: CallEdge) => x.fromId === "ClassFunction:OrderEntity.validate");
    expect(e).toBeTruthy();
    expect(e!.receiver).toBeUndefined();
  });
});
