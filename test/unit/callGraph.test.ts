import { describe, expect, it } from "vitest";
import { CallGraph, SymbolKind, CallKind, INDEX_VERSION } from "../../packages/core/dist";
import type { SymbolIndex, SymbolRecord, CallEdge } from "../../packages/core/dist";

function sym(id: string, name: string, kind: SymbolKind = SymbolKind.ProjectMethod): SymbolRecord {
  return { id, name, kind, location: { uri: `file:///${name}`, line: 0 } };
}

function edge(fromId: string, toId: string): CallEdge {
  return { fromId, toId, callKind: CallKind.Static, line: 0, raw: "", resolved: true };
}

function makeIndex(): SymbolIndex {
  return {
    version: INDEX_VERSION,
    builtAt: 0,
    projectRoot: "/tmp/x",
    symbols: [],
    edges: [],
    fileMtimes: {}
  };
}

describe("CallGraph mutation API", () => {
  it("addSymbol inserts into the live index and lookup maps", () => {
    const idx = makeIndex();
    const g = new CallGraph(idx);
    g.addSymbol(sym("ProjectMethod:Foo", "Foo"));
    expect(idx.symbols).toHaveLength(1);
    expect(g.symbol("ProjectMethod:Foo")?.name).toBe("Foo");
    expect(g.byName("foo")).toHaveLength(1);
  });

  it("addSymbol is a no-op if the id already exists", () => {
    const idx = makeIndex();
    const g = new CallGraph(idx);
    g.addSymbol(sym("ProjectMethod:Foo", "Foo"));
    g.addSymbol(sym("ProjectMethod:Foo", "Foo"));
    expect(idx.symbols).toHaveLength(1);
    expect(g.byName("foo")).toHaveLength(1);
  });

  it("addEdge wires forward and reverse maps", () => {
    const idx = makeIndex();
    const g = new CallGraph(idx);
    g.addSymbol(sym("ProjectMethod:A", "A"));
    g.addSymbol(sym("ProjectMethod:B", "B"));
    const e = edge("ProjectMethod:A", "ProjectMethod:B");
    g.addEdge(e);
    expect(idx.edges).toHaveLength(1);
    expect(g.callees("ProjectMethod:A").map((x) => x.toId)).toEqual(["ProjectMethod:B"]);
    expect(g.callers("ProjectMethod:B").map((x) => x.fromId)).toEqual(["ProjectMethod:A"]);
  });

  it("removeSymbolsByIds removes outgoing edges by default and keeps incoming", () => {
    const idx = makeIndex();
    const g = new CallGraph(idx);
    g.addSymbol(sym("ProjectMethod:A", "A"));
    g.addSymbol(sym("ProjectMethod:B", "B"));
    g.addSymbol(sym("ProjectMethod:C", "C"));
    const ab = edge("ProjectMethod:A", "ProjectMethod:B");
    const cb = edge("ProjectMethod:C", "ProjectMethod:B");
    const ca = edge("ProjectMethod:C", "ProjectMethod:A");
    g.addEdge(ab);
    g.addEdge(cb);
    g.addEdge(ca);

    const { removedEdges } = g.removeSymbolsByIds(["ProjectMethod:A"]);

    // Only the outgoing edge (A → B) is removed. The incoming edge (C → A)
    // is kept so a follow-up fan-out step can decide whether to re-resolve
    // it (e.g., when A is re-added with the same id during a file patch).
    expect(removedEdges).toEqual([ab]);
    expect(idx.symbols.map((s) => s.id)).toEqual(["ProjectMethod:B", "ProjectMethod:C"]);
    expect(idx.edges.length).toBe(2); // cb (C→B) + ca (C→A, stale)
    expect(g.symbol("ProjectMethod:A")).toBeUndefined();
    expect(g.byName("a")).toEqual([]);
    expect(g.callees("ProjectMethod:A")).toEqual([]);
    expect(g.callers("ProjectMethod:B").map((e) => e.fromId)).toEqual(["ProjectMethod:C"]);
  });

  it("removeSymbolsByIds with alsoRemoveIncoming drops both directions", () => {
    const idx = makeIndex();
    const g = new CallGraph(idx);
    g.addSymbol(sym("ProjectMethod:A", "A"));
    g.addSymbol(sym("ProjectMethod:B", "B"));
    g.addSymbol(sym("ProjectMethod:C", "C"));
    const ab = edge("ProjectMethod:A", "ProjectMethod:B");
    const cb = edge("ProjectMethod:C", "ProjectMethod:B");
    const ca = edge("ProjectMethod:C", "ProjectMethod:A");
    g.addEdge(ab);
    g.addEdge(cb);
    g.addEdge(ca);

    const { removedEdges } = g.removeSymbolsByIds(["ProjectMethod:A"], { alsoRemoveIncoming: true });

    expect(removedEdges).toHaveLength(2);
    expect(removedEdges).toContain(ab);
    expect(removedEdges).toContain(ca);
    expect(idx.edges).toEqual([cb]);
    expect(g.callers("ProjectMethod:A")).toEqual([]);
  });

  it("removeSymbolsByIds with empty set is a no-op", () => {
    const idx = makeIndex();
    const g = new CallGraph(idx);
    g.addSymbol(sym("ProjectMethod:A", "A"));
    const r = g.removeSymbolsByIds([]);
    expect(r.removedEdges).toEqual([]);
    expect(idx.symbols).toHaveLength(1);
  });

  it("removeEdge removes a single edge identified by reference", () => {
    const idx = makeIndex();
    const g = new CallGraph(idx);
    g.addSymbol(sym("ProjectMethod:A", "A"));
    g.addSymbol(sym("ProjectMethod:B", "B"));
    const e1 = edge("ProjectMethod:A", "ProjectMethod:B");
    const e2 = edge("ProjectMethod:A", "ProjectMethod:B");
    g.addEdge(e1);
    g.addEdge(e2);
    g.removeEdge(e1);
    expect(idx.edges).toEqual([e2]);
    expect(g.callees("ProjectMethod:A")).toEqual([e2]);
    expect(g.callers("ProjectMethod:B")).toEqual([e2]);
  });

  it("removeEdge drops empty buckets so allEmpty queries return []", () => {
    const idx = makeIndex();
    const g = new CallGraph(idx);
    g.addSymbol(sym("ProjectMethod:A", "A"));
    g.addSymbol(sym("ProjectMethod:B", "B"));
    const e = edge("ProjectMethod:A", "ProjectMethod:B");
    g.addEdge(e);
    g.removeEdge(e);
    expect(g.callees("ProjectMethod:A")).toEqual([]);
    expect(g.callers("ProjectMethod:B")).toEqual([]);
  });
});
