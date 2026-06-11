import { describe, expect, it } from "vitest";
import { CallGraph, SymbolKind, CallKind, INDEX_VERSION } from "../../packages/core/dist";
import type { SymbolIndex, SymbolRecord, CallEdge } from "../../packages/core/dist";
import { buildTraceChildren } from "../../packages/vscode-client/src/views/traceView/traceData";

function sym(id: string, name: string, kind: SymbolKind = SymbolKind.ProjectMethod): SymbolRecord {
  return { id, name, kind, location: { uri: `file:///${name}`, line: 0 } };
}

function edge(fromId: string, toId: string, line = 0, column?: number, raw = ""): CallEdge {
  return { fromId, toId, callKind: CallKind.Static, line, column, raw, resolved: true };
}

function makeGraph(names: string[], edges: CallEdge[]): CallGraph {
  const idx: SymbolIndex = {
    version: INDEX_VERSION,
    builtAt: 0,
    projectRoot: "/tmp/x",
    symbols: [],
    edges: [],
    fileMtimes: {}
  };
  const g = new CallGraph(idx);
  for (const n of names) g.addSymbol(sym(n, n));
  for (const e of edges) g.addEdge(e);
  return g;
}

function counter(): () => string {
  let n = 0;
  return () => String(n++);
}

describe("buildTraceChildren", () => {
  it("returns rows sorted by (line, column) regardless of insertion order", () => {
    const g = makeGraph(
      ["A", "X", "Y", "Z"],
      [edge("A", "Z", 30), edge("A", "X", 5), edge("A", "Y", 5, 12), edge("A", "X", 5, 2)]
    );
    const rows = buildTraceChildren(g, "A", new Set(["A"]), 1, counter(), { left: 100 });
    expect(rows.map((r) => [r.calleeId, r.line, r.column ?? 0])).toEqual([
      ["X", 5, 0],
      ["X", 5, 2],
      ["Y", 5, 12],
      ["Z", 30, 0]
    ]);
  });

  it("emits one row per call site, not per callee", () => {
    const g = makeGraph(["A", "B"], [edge("A", "B", 1, 0, "B($x)"), edge("A", "B", 9, 0, "B($y)")]);
    const rows = buildTraceChildren(g, "A", new Set(["A"]), 1, counter(), { left: 100 });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.raw)).toEqual(["B($x)", "B($y)"]);
  });

  it("marks direct recursion and never descends into it", () => {
    const g = makeGraph(["A"], [edge("A", "A", 3)]);
    const rows = buildTraceChildren(g, "A", new Set(["A"]), 10, counter(), { left: 100 });
    expect(rows).toHaveLength(1);
    expect(rows[0].recursive).toBe(true);
    expect(rows[0].children).toBeUndefined();
  });

  it("marks indirect recursion (A→B→A) without infinite descent", () => {
    const g = makeGraph(["A", "B"], [edge("A", "B", 1), edge("B", "A", 2)]);
    const rows = buildTraceChildren(g, "A", new Set(["A"]), 10, counter(), { left: 100 });
    expect(rows[0].calleeId).toBe("B");
    expect(rows[0].recursive).toBe(false);
    expect(rows[0].children).toHaveLength(1);
    expect(rows[0].children![0].calleeId).toBe("A");
    expect(rows[0].children![0].recursive).toBe(true);
    expect(rows[0].children![0].children).toBeUndefined();
  });

  it("pre-expands to the requested depth with nested children", () => {
    const g = makeGraph(["A", "B", "C", "D"], [edge("A", "B", 1), edge("B", "C", 1), edge("C", "D", 1)]);
    const rows = buildTraceChildren(g, "A", new Set(["A"]), 2, counter(), { left: 100 });
    expect(rows[0].calleeId).toBe("B");
    expect(rows[0].children![0].calleeId).toBe("C");
    // depth 2 stops there; C's children not built, but childCount still reported
    expect(rows[0].children![0].children).toBeUndefined();
    expect(rows[0].children![0].childCount).toBe(1);
  });

  it("respects the row budget across the whole subtree", () => {
    const callees = Array.from({ length: 10 }, (_, i) => `T${i}`);
    const g = makeGraph(["A", ...callees], callees.map((t, i) => edge("A", t, i)));
    const budget = { left: 4 };
    const rows = buildTraceChildren(g, "A", new Set(["A"]), 1, counter(), budget);
    expect(rows).toHaveLength(4);
    expect(budget.left).toBe(0);
  });

  it("reports unresolved callees with an Unresolved kind", () => {
    const g = makeGraph(["A"], [{ ...edge("A", "Unresolved:ghost", 1), resolved: false }]);
    const rows = buildTraceChildren(g, "A", new Set(["A"]), 1, counter(), { left: 100 });
    expect(rows[0].kind).toBe(SymbolKind.Unresolved);
    expect(rows[0].resolved).toBe(false);
  });

  it("assigns unique nodeIds via the supplied counter", () => {
    const g = makeGraph(["A", "B", "C"], [edge("A", "B", 1), edge("A", "C", 2)]);
    const rows = buildTraceChildren(g, "A", new Set(["A"]), 1, counter(), { left: 100 });
    expect(new Set(rows.map((r) => r.nodeId)).size).toBe(2);
  });
});
