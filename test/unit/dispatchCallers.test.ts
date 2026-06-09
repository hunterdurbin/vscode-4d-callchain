import { describe, expect, it } from "vitest";
import { CallGraph, CallKind, SymbolKind, INDEX_VERSION, dispatchCallers } from "../../packages/core/dist";
import type { SymbolIndex, SymbolRecord, CallEdge } from "../../packages/core/dist";

const ROOT = "/proj";

function classSym(name: string, extendsClass?: string): SymbolRecord {
  return { id: `Class:${name}`, name, kind: SymbolKind.Class, extendsClass, location: { uri: `file://${ROOT}/${name}.4dm`, line: 0 } };
}
function classFn(owner: string, name: string): SymbolRecord {
  return { id: `ClassFunction:${owner}.${name}`, name, kind: SymbolKind.ClassFunction, ownerClass: owner, location: { uri: `file://${ROOT}/${owner}.4dm`, line: 3 } };
}
function method(name: string): SymbolRecord {
  return { id: `ProjectMethod:${name}`, name, kind: SymbolKind.ProjectMethod, location: { uri: `file://${ROOT}/${name}.4dm`, line: 0 } };
}
function edge(fromId: string, toId: string, line = 1, column?: number): CallEdge {
  return { fromId, toId, callKind: CallKind.Static, line, raw: `${toId}()`, resolved: true, column };
}

/**
 * Base.execute <- Dispatcher (typed to base). Mid extends Base and overrides
 * execute; Leaf extends Mid and overrides execute. DirectCaller calls Leaf.execute
 * directly. GrandDispatcher calls (a different) Base via Base.execute too.
 */
function makeGraph(): CallGraph {
  const symbols: SymbolRecord[] = [
    classSym("Base"),
    classSym("Mid", "Base"),
    classSym("Leaf", "Mid"),
    classFn("Base", "execute"),
    classFn("Mid", "execute"),
    classFn("Leaf", "execute"),
    method("Dispatcher"),
    method("MidDispatcher"),
    method("DirectCaller")
  ];
  const edges: CallEdge[] = [
    // Polymorphic call sites typed to ancestors.
    edge("ProjectMethod:Dispatcher", "ClassFunction:Base.execute", 10, 4),
    edge("ProjectMethod:MidDispatcher", "ClassFunction:Mid.execute", 20, 4),
    // A direct caller of the Leaf override itself.
    edge("ProjectMethod:DirectCaller", "ClassFunction:Leaf.execute", 30, 4)
  ];
  const idx: SymbolIndex = { version: INDEX_VERSION, builtAt: 0, projectRoot: ROOT, symbols, edges, fileMtimes: {} };
  return new CallGraph(idx);
}

describe("dispatchCallers", () => {
  const g = makeGraph();

  it("returns every ancestor's call sites for a deep override", () => {
    const groups = dispatchCallers(g, "ClassFunction:Leaf.execute");
    // Both Base.execute and Mid.execute are ancestors with callers.
    expect(groups.map((x) => x.base.id).sort()).toEqual(["ClassFunction:Base.execute", "ClassFunction:Mid.execute"]);
    const base = groups.find((x) => x.base.id === "ClassFunction:Base.execute")!;
    expect(base.sites.map((e) => e.fromId)).toEqual(["ProjectMethod:Dispatcher"]);
    const mid = groups.find((x) => x.base.id === "ClassFunction:Mid.execute")!;
    expect(mid.sites.map((e) => e.fromId)).toEqual(["ProjectMethod:MidDispatcher"]);
  });

  it("only reports ancestors that have callers", () => {
    // Mid overrides Base.execute; Base has the Dispatcher caller, Mid has none
    // above it that aren't already counted — so Mid.execute surfaces Base only.
    const groups = dispatchCallers(g, "ClassFunction:Mid.execute");
    expect(groups.map((x) => x.base.id)).toEqual(["ClassFunction:Base.execute"]);
  });

  it("returns [] for a base method that overrides nothing", () => {
    expect(dispatchCallers(g, "ClassFunction:Base.execute")).toEqual([]);
  });

  it("excludes a site that is already a direct caller of the override", () => {
    // Add a graph where DirectCaller calls BOTH Leaf.execute and Base.execute at
    // the same call site key — the via-base list must not double-count it.
    const symbols = (g as any).allSymbols() as SymbolRecord[];
    const edges: CallEdge[] = [
      edge("ProjectMethod:Dispatcher", "ClassFunction:Base.execute", 10, 4),
      // DirectCaller is a direct caller of Leaf.execute AND of Base.execute at the
      // identical (from,line,column) — the base one must be filtered out.
      edge("ProjectMethod:DirectCaller", "ClassFunction:Leaf.execute", 30, 4),
      edge("ProjectMethod:DirectCaller", "ClassFunction:Base.execute", 30, 4)
    ];
    const idx: SymbolIndex = { version: INDEX_VERSION, builtAt: 0, projectRoot: ROOT, symbols, edges, fileMtimes: {} };
    const g2 = new CallGraph(idx);
    const groups = dispatchCallers(g2, "ClassFunction:Leaf.execute");
    const base = groups.find((x) => x.base.id === "ClassFunction:Base.execute")!;
    expect(base.sites.map((e) => e.fromId)).toEqual(["ProjectMethod:Dispatcher"]); // DirectCaller excluded
  });
});
