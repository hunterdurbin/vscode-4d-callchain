import { describe, expect, it } from "vitest";
import { CallGraph, SymbolKind, CallKind, ClassFlavor, INDEX_VERSION } from "../../packages/core/dist";
import type { SymbolIndex, SymbolRecord, CallEdge } from "../../packages/core/dist";
import {
  callPath,
  classHierarchy,
  classMembers,
  findCallees,
  findCallers,
  findInstantiations,
  findOverriddenQuery,
  findOverridesQuery,
  getSymbol,
  isQueryError,
  reachableQuery,
  searchSymbols
} from "../../packages/mcp-server/dist/queries.js";

const ROOT = "/proj";

function method(id: string, name: string, line = 0): SymbolRecord {
  return { id, name, kind: SymbolKind.ProjectMethod, location: { uri: `file://${ROOT}/Project/Sources/Methods/${name}.4dm`, line } };
}
function classSym(name: string, extendsClass?: string): SymbolRecord {
  return { id: `Class:${name}`, name, kind: SymbolKind.Class, extendsClass, location: { uri: `file://${ROOT}/Project/Sources/Classes/${name}.4dm`, line: 0 } };
}
function classFn(owner: string, name: string): SymbolRecord {
  return { id: `ClassFunction:${owner}.${name}`, name, kind: SymbolKind.ClassFunction, ownerClass: owner, location: { uri: `file://${ROOT}/Project/Sources/Classes/${owner}.4dm`, line: 3 } };
}
function edge(fromId: string, toId: string, line = 1, column?: number, callKind = CallKind.Static, resolved = true): CallEdge {
  return { fromId, toId, callKind, line, raw: `${toId}()`, resolved, column };
}

/**
 * Synthetic project:
 *   M1 -> M2 -> M3 (call chain)
 *   class Base { foo }, class Sub extends Base { foo (override) }
 *   two methods both named "Dup" (ambiguous by name)
 */
function makeGraph(): CallGraph {
  const symbols: SymbolRecord[] = [
    method("ProjectMethod:M1", "M1"),
    method("ProjectMethod:M2", "M2"),
    method("ProjectMethod:M3", "M3"),
    method("ProjectMethod:M4", "M4"),
    classSym("Base"),
    classSym("Sub", "Base"),
    classFn("Base", "foo"),
    classFn("Sub", "foo"),
    // A getter on Base with a non-default scope/accessor, plus a same-named
    // ProjectMethod that must NOT show up as a member of Base.
    { id: "ClassGetter:Base.bar", name: "bar", kind: SymbolKind.ClassGetter, ownerClass: "Base", scope: "local", accessor: "get", location: { uri: `file://${ROOT}/Project/Sources/Classes/Base.4dm`, line: 8 } },
    method("ProjectMethod:bar", "bar"),
    { id: "ProjectMethod:Dup#a", name: "Dup", kind: SymbolKind.ProjectMethod, location: { uri: `file://${ROOT}/a.4dm`, line: 0 } },
    { id: "ProjectMethod:Dup#b", name: "Dup", kind: SymbolKind.ProjectMethod, location: { uri: `file://${ROOT}/b.4dm`, line: 0 } },
    // ORDA: entity FooEntity + dataclass Foo, with synthetic ds.Foo.* TableBuiltins.
    { id: "Class:FooEntity", name: "FooEntity", kind: SymbolKind.Class, classFlavor: ClassFlavor.Entity, location: { uri: `file://${ROOT}/Project/Sources/Classes/FooEntity.4dm`, line: 0 } },
    { id: "Class:Foo", name: "Foo", kind: SymbolKind.Class, classFlavor: ClassFlavor.DataClass, location: { uri: `file://${ROOT}/Project/Sources/Classes/Foo.4dm`, line: 0 } },
    { id: "TableBuiltin:ds.Foo.new", name: "ds.Foo.new", kind: SymbolKind.TableBuiltin, ownerTable: "Foo", location: { uri: "", line: 0 } },
    { id: "TableBuiltin:ds.Foo.query", name: "ds.Foo.query", kind: SymbolKind.TableBuiltin, ownerTable: "Foo", location: { uri: "", line: 0 } },
    method("ProjectMethod:UsesFoo", "UsesFoo"),
    // A plain (non-ORDA) class with a constructor: `cs.Job.new()` edges land on
    // the constructor symbol, so find_instantiations must harvest its callers.
    classSym("Job"),
    { id: "ClassConstructor:Job.constructor", name: "constructor", kind: SymbolKind.ClassConstructor, ownerClass: "Job", location: { uri: `file://${ROOT}/Project/Sources/Classes/Job.4dm`, line: 1 } },
    method("ProjectMethod:BuildJob", "BuildJob"),
    // A polymorphic dispatch site: Dispatcher calls Base.foo (typed to the
    // base), which can dispatch to the Sub.foo override at runtime.
    method("ProjectMethod:Dispatcher", "Dispatcher")
  ];
  const edges: CallEdge[] = [
    edge("ProjectMethod:M1", "ProjectMethod:M2", 5),
    edge("ProjectMethod:M2", "ProjectMethod:M3", 7),
    // M4 -> M3 twice at the same call site (line 10, col 5), differing only in
    // callKind/resolved (a duplicate-edge artifact), plus a genuinely distinct
    // call to M3 on the same line at col 20.
    edge("ProjectMethod:M4", "ProjectMethod:M3", 10, 5, CallKind.Dynamic, false),
    edge("ProjectMethod:M4", "ProjectMethod:M3", 10, 5, CallKind.Static, true),
    edge("ProjectMethod:M4", "ProjectMethod:M3", 10, 20),
    // UsesFoo creates and queries the dataclass.
    edge("ProjectMethod:UsesFoo", "TableBuiltin:ds.Foo.new", 3, 4),
    edge("ProjectMethod:UsesFoo", "TableBuiltin:ds.Foo.query", 5, 4),
    // cs.Job.new() — edge targets the constructor, not the Class symbol.
    edge("ProjectMethod:BuildJob", "ClassConstructor:Job.constructor", 12, 4),
    // $base.foo() typed to Base — resolves to Base.foo, dispatches to Sub.foo.
    edge("ProjectMethod:Dispatcher", "ClassFunction:Base.foo", 20, 4)
  ];
  const idx: SymbolIndex = { version: INDEX_VERSION, builtAt: 0, projectRoot: ROOT, symbols, edges, fileMtimes: {} };
  return new CallGraph(idx);
}

describe("mcp queries", () => {
  const g = makeGraph();

  it("search_symbols ranks and filters by kind", () => {
    const r = searchSymbols(g, ROOT, { query: "M", kind: "ProjectMethod", limit: 10 });
    expect(r.results.map((s) => s.name)).toEqual(["M1", "M2", "M3", "M4"]);
  });

  it("summaries use project-relative paths and 1-based lines", () => {
    const r = getSymbol(g, ROOT, { symbolId: "ProjectMethod:M1" });
    expect(isQueryError(r)).toBe(false);
    if (isQueryError(r)) return;
    expect(r.file).toBe("Project/Sources/Methods/M1.4dm");
    expect(r.line).toBe(1); // stored line 0 -> exposed 1
    expect(r.calleeCount).toBe(1);
  });

  it("find_callees / find_callers traverse edges with call-site lines", () => {
    const callees = findCallees(g, ROOT, { symbolId: "ProjectMethod:M2" });
    if (isQueryError(callees)) throw new Error("unexpected error");
    expect(callees.callees[0].symbol.name).toBe("M3");
    expect(callees.callees[0].callLine).toBe(8); // edge line 7 -> 1-based 8

    const callers = findCallers(g, ROOT, { symbolId: "ProjectMethod:M2" });
    if (isQueryError(callers)) throw new Error("unexpected error");
    expect(callers.callers[0].symbol.name).toBe("M1");
  });

  it("find_callees collapses duplicate edges at the same call site, keeping the resolved one", () => {
    const r = findCallees(g, ROOT, { symbolId: "ProjectMethod:M4" });
    if (isQueryError(r)) throw new Error("unexpected error");
    // 3 raw edges -> 2 after dedup: the (line 10, col 5) pair collapses; (col 20) stays.
    expect(r.count).toBe(2);
    const atCol5 = r.callees.find((c) => c.callLine === 11); // line 10 -> 1-based 11
    expect(atCol5?.resolved).toBe(true); // resolved edge wins the tie
    expect(atCol5?.callKind).toBe("Static");

    // getSymbol's calleeCount is deduped too.
    const sym = getSymbol(g, ROOT, { symbolId: "ProjectMethod:M4" });
    if (isQueryError(sym)) throw new Error("unexpected error");
    expect(sym.calleeCount).toBe(2);
  });

  it("reachable returns the bounded forward set", () => {
    const r = reachableQuery(g, ROOT, { symbolId: "ProjectMethod:M1" }, 2, "forward");
    if (isQueryError(r)) throw new Error("unexpected error");
    expect(r.nodes.map((n) => n.name).sort()).toEqual(["M2", "M3"]);
  });

  it("call_path finds the chain M1 -> M3", () => {
    const r = callPath(g, ROOT, { symbolId: "ProjectMethod:M1" }, { symbolId: "ProjectMethod:M3" }, 8, "forward");
    if (isQueryError(r)) throw new Error("unexpected error");
    expect(r.found).toBe(true);
    expect(r.path.map((s) => s.name)).toEqual(["M1", "M2", "M3"]);
  });

  it("class_hierarchy reports ancestors and descendants", () => {
    const sub = classHierarchy(g, ROOT, "Sub");
    if (isQueryError(sub)) throw new Error("unexpected error");
    expect(sub.ancestors.map((s) => s.name)).toEqual(["Base"]);

    const base = classHierarchy(g, ROOT, "Base");
    if (isQueryError(base)) throw new Error("unexpected error");
    expect(base.directSubclasses.map((s) => s.name)).toEqual(["Sub"]);
    expect(base.descendants.map((s) => s.name)).toEqual(["Sub"]);
  });

  it("class_members lists a class's own members with scope/accessor, excluding same-named non-members", () => {
    const r = classMembers(g, ROOT, "Base");
    if (isQueryError(r)) throw new Error("unexpected error");
    // foo (line 3) then bar (line 8), sorted by line; the ProjectMethod "bar" is excluded.
    expect(r.count).toBe(2);
    expect(r.members.map((m) => m.name)).toEqual(["foo", "bar"]);
    const bar = r.members.find((m) => m.name === "bar")!;
    expect(bar.kind).toBe("ClassGetter");
    expect(bar.scope).toBe("local");
    expect(bar.accessor).toBe("get");
    expect(bar.line).toBe(9); // stored line 8 -> 1-based 9
    expect(typeof bar.callerCount).toBe("number");

    const missing = classMembers(g, ROOT, "Nope");
    expect(isQueryError(missing)).toBe(true);
  });

  it("class_members labels overrides and surfaces inherited members", () => {
    const r = classMembers(g, ROOT, "Sub");
    if (isQueryError(r)) throw new Error("unexpected error");
    // Sub declares foo (overrides Base.foo); Sub inherits bar (getter) from Base.
    const foo = r.members.find((m) => m.name === "foo")!;
    expect(foo.overrides).toEqual({ id: "ClassFunction:Base.foo", ownerClass: "Base" });
    expect(r.inherited.map((m) => m.name)).toEqual(["bar"]);
    expect(r.inherited[0].ownerClass).toBe("Base");
    // bar is inherited, not shadowed, so it is NOT in own members.
    expect(r.members.map((m) => m.name)).not.toContain("bar");
  });

  it("find_instantiations links an entity to its dataclass CRUD sites", () => {
    // Entity → derive dataclass "Foo" → callers of ds.Foo.* are the sites.
    const r = findInstantiations(g, ROOT, "FooEntity");
    if (isQueryError(r)) throw new Error("unexpected error");
    expect(r.dataClass).toBe("Foo");
    expect(r.count).toBe(2);
    expect(r.sites.every((s) => s.symbol.name === "UsesFoo")).toBe(true);
    expect(r.sites.map((s) => s.via).sort()).toEqual(["ds.Foo.new", "ds.Foo.query"]);

    // Passing the dataclass itself resolves to the same usage sites.
    const dc = findInstantiations(g, ROOT, "Foo");
    if (isQueryError(dc)) throw new Error("unexpected error");
    expect(dc.dataClass).toBe("Foo");
    expect(dc.count).toBe(2);
  });

  it("find_instantiations surfaces cs.<Class>.new() sites for a plain class via its constructor", () => {
    const r = findInstantiations(g, ROOT, "Job");
    if (isQueryError(r)) throw new Error("unexpected error");
    expect(r.dataClass).toBeUndefined(); // not ORDA
    expect(r.count).toBe(1);
    expect(r.sites[0].symbol.name).toBe("BuildJob");
    expect(r.sites[0].via).toBe("cs.Job.new");
  });

  it("find_callers surfaces polymorphic dispatch on an override under viaBase, count stays direct-only", () => {
    const r = findCallers(g, ROOT, { symbolId: "ClassFunction:Sub.foo" });
    if (isQueryError(r)) throw new Error("unexpected error");
    // No direct callers point at the override itself.
    expect(r.count).toBe(0);
    expect(r.callers).toEqual([]);
    // …but the base method's call site dispatches here.
    expect(r.viaBase?.length).toBe(1);
    expect(r.viaBase![0].base.id).toBe("ClassFunction:Base.foo");
    expect(r.viaBase![0].sites.map((s) => s.symbol.name)).toEqual(["Dispatcher"]);
    expect(r.viaBase![0].sites[0].via).toBe("dispatched via base cs.Base.foo");
  });

  it("find_callers omits viaBase for a base method (overrides nothing)", () => {
    const r = findCallers(g, ROOT, { symbolId: "ClassFunction:Base.foo" });
    if (isQueryError(r)) throw new Error("unexpected error");
    expect(r.count).toBe(1); // the direct Dispatcher caller
    expect(r.viaBase).toBeUndefined();
  });

  it("find_overrides / find_overridden resolve the Base.foo <-> Sub.foo pair", () => {
    const ov = findOverridesQuery(g, ROOT, { symbolId: "ClassFunction:Base.foo" });
    if (isQueryError(ov)) throw new Error("unexpected error");
    expect(ov.overrides.map((s) => s.id)).toEqual(["ClassFunction:Sub.foo"]);

    const back = findOverriddenQuery(g, ROOT, { symbolId: "ClassFunction:Sub.foo" });
    if (isQueryError(back)) throw new Error("unexpected error");
    expect(back.overridden?.id).toBe("ClassFunction:Base.foo");
  });

  it("reports not-found and ambiguous selectors as query errors", () => {
    const missing = getSymbol(g, ROOT, { name: "Nope" });
    expect(isQueryError(missing)).toBe(true);

    const ambiguous = getSymbol(g, ROOT, { name: "Dup" });
    expect(isQueryError(ambiguous)).toBe(true);
    if (isQueryError(ambiguous)) expect(ambiguous.candidates).toHaveLength(2);
  });
});
