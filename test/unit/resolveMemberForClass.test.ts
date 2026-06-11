import { describe, expect, it } from "vitest";
import {
  CallGraph,
  SymbolKind,
  INDEX_VERSION,
  resolveMemberForClass,
  overrideCandidates,
  overridesForClass
} from "../../packages/core/dist";
import type { SymbolIndex, SymbolRecord } from "../../packages/core/dist";

function classSym(name: string, extendsClass?: string): SymbolRecord {
  return {
    id: `Class:${name}`,
    name,
    kind: SymbolKind.Class,
    location: { uri: `file:///${name}.4dm`, line: 0 },
    ...(extendsClass ? { extendsClass } : {})
  };
}

function member(owner: string, name: string, kind: SymbolKind): SymbolRecord {
  return {
    id: `${kind}:${owner}.${name}`,
    name,
    kind,
    ownerClass: owner,
    location: { uri: `file:///${owner}.4dm`, line: 1 }
  };
}

function makeGraph(symbols: SymbolRecord[]): CallGraph {
  const idx: SymbolIndex = {
    version: INDEX_VERSION,
    builtAt: 0,
    projectRoot: "/tmp/x",
    symbols,
    edges: [],
    fileMtimes: {}
  };
  return new CallGraph(idx);
}

// Animal ← Dog ← Puppy hierarchy used throughout.
function hierarchy(extra: SymbolRecord[] = []): CallGraph {
  return makeGraph([
    classSym("Animal"),
    classSym("Dog", "Animal"),
    classSym("Puppy", "Dog"),
    ...extra
  ]);
}

describe("resolveMemberForClass", () => {
  it("returns the class's own declaration first", () => {
    const g = hierarchy([
      member("Animal", "hook", SymbolKind.ClassFunction),
      member("Dog", "hook", SymbolKind.ClassFunction)
    ]);
    expect(resolveMemberForClass(g, "Dog", "hook", "call")?.id).toBe("ClassFunction:Dog.hook");
  });

  it("walks up to the nearest ancestor declaration", () => {
    const g = hierarchy([
      member("Animal", "hook", SymbolKind.ClassFunction),
      member("Dog", "hook", SymbolKind.ClassFunction)
    ]);
    // Puppy has no own hook → Dog's (nearest), not Animal's.
    expect(resolveMemberForClass(g, "Puppy", "hook", "call")?.id).toBe("ClassFunction:Dog.hook");
  });

  it("a base getter beats a derived plain property (full pass per kind)", () => {
    const g = hierarchy([
      member("Animal", "label", SymbolKind.ClassGetter),
      member("Dog", "label", SymbolKind.ClassProperty)
    ]);
    expect(resolveMemberForClass(g, "Dog", "label", "read")?.id).toBe("ClassGetter:Animal.label");
  });

  it("write slot finds setters, not getters", () => {
    const g = hierarchy([
      member("Animal", "label", SymbolKind.ClassGetter),
      member("Dog", "label", SymbolKind.ClassSetter)
    ]);
    expect(resolveMemberForClass(g, "Puppy", "label", "write")?.id).toBe("ClassSetter:Dog.label");
    expect(resolveMemberForClass(g, "Puppy", "label", "read")?.id).toBe("ClassGetter:Animal.label");
  });

  it("aliases resolve for both read and write slots", () => {
    const g = hierarchy([member("Dog", "nick", SymbolKind.Alias)]);
    expect(resolveMemberForClass(g, "Puppy", "nick", "read")?.id).toBe("Alias:Dog.nick");
    expect(resolveMemberForClass(g, "Puppy", "nick", "write")?.id).toBe("Alias:Dog.nick");
  });

  it("call slot ignores getters/setters/properties", () => {
    const g = hierarchy([member("Animal", "hook", SymbolKind.ClassGetter)]);
    expect(resolveMemberForClass(g, "Dog", "hook", "call")).toBeUndefined();
  });

  it("returns undefined on a total miss (abstract hook)", () => {
    const g = hierarchy();
    expect(resolveMemberForClass(g, "Dog", "hook", "call")).toBeUndefined();
  });

  it("is case-insensitive on class and member names", () => {
    const g = hierarchy([member("Animal", "Hook", SymbolKind.ClassFunction)]);
    expect(resolveMemberForClass(g, "dog", "hook", "call")?.id).toBe("ClassFunction:Animal.Hook");
  });

  it("survives an extends cycle without hanging", () => {
    const g = makeGraph([
      classSym("A", "B"),
      classSym("B", "A"),
      member("B", "fn", SymbolKind.ClassFunction)
    ]);
    expect(resolveMemberForClass(g, "A", "fn", "call")?.id).toBe("ClassFunction:B.fn");
    expect(resolveMemberForClass(g, "A", "missing", "call")).toBeUndefined();
  });
});

describe("overrideCandidates", () => {
  it("returns descendant overrides filtered by slot kind", () => {
    const g = hierarchy([
      member("Dog", "hook", SymbolKind.ClassFunction),
      member("Puppy", "hook", SymbolKind.ClassFunction),
      member("Puppy", "hook2", SymbolKind.ClassGetter)
    ]);
    expect(overrideCandidates(g, "Animal", "hook", "call").map((s) => s.id)).toEqual([
      "ClassFunction:Dog.hook",
      "ClassFunction:Puppy.hook"
    ]);
    // A getter is not a "call" candidate, and vice versa.
    expect(overrideCandidates(g, "Animal", "hook2", "call")).toEqual([]);
    expect(overrideCandidates(g, "Animal", "hook2", "read").map((s) => s.id)).toEqual([
      "ClassGetter:Puppy.hook2"
    ]);
  });

  it("works when the base member has no symbol at all (abstract hook)", () => {
    const g = hierarchy([member("Dog", "hook", SymbolKind.ClassFunction)]);
    expect(overrideCandidates(g, "Animal", "hook", "call").map((s) => s.id)).toEqual([
      "ClassFunction:Dog.hook"
    ]);
  });

  it("accepts a precomputed overridesForClass map", () => {
    const g = hierarchy([member("Dog", "hook", SymbolKind.ClassFunction)]);
    const pre = overridesForClass(g, "Animal");
    expect(overrideCandidates(g, "Animal", "hook", "call", pre).map((s) => s.id)).toEqual([
      "ClassFunction:Dog.hook"
    ]);
  });

  it("returns [] when the class has no descendants", () => {
    const g = hierarchy([member("Puppy", "hook", SymbolKind.ClassFunction)]);
    expect(overrideCandidates(g, "Puppy", "hook", "call")).toEqual([]);
  });
});
