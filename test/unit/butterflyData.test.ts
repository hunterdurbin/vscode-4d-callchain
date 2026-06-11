import { describe, expect, it } from "vitest";
import { CallGraph, SymbolKind, CallKind, INDEX_VERSION } from "../../packages/core/dist";
import type { SymbolIndex, SymbolRecord, CallEdge } from "../../packages/core/dist";
import { buildButterfly } from "../../packages/vscode-client/src/views/graphView/butterflyData";

function sym(id: string, name: string, kind: SymbolKind = SymbolKind.ProjectMethod): SymbolRecord {
  return { id, name, kind, location: { uri: `file:///${name}`, line: 0 } };
}

function edge(fromId: string, toId: string): CallEdge {
  return { fromId, toId, callKind: CallKind.Static, line: 0, raw: "", resolved: true };
}

function makeGraph(names: string[], pairs: [string, string][]): CallGraph {
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
  for (const [a, b] of pairs) g.addEdge(edge(a, b));
  return g;
}

const NO_HISTORY = { back: false, fwd: false };

describe("buildButterfly", () => {
  it("places callers strictly left and callees strictly right", () => {
    // X → A → Y
    const g = makeGraph(["A", "X", "Y"], [["X", "A"], ["A", "Y"]]);
    const d = buildButterfly(g, "A", 2, new Set(), NO_HISTORY);
    const byEl = new Map(d.nodes.map((n) => [n.elId, n]));
    expect(byEl.get("C")?.symbolId).toBe("A");
    expect(byEl.get("L:X")?.side).toBe("caller");
    expect(byEl.get("R:Y")?.side).toBe("callee");
    expect(d.nodes.filter((n) => n.side === "caller").every((n) => n.elId.startsWith("L:"))).toBe(true);
    expect(d.nodes.filter((n) => n.side === "callee").every((n) => n.elId.startsWith("R:"))).toBe(true);
    // arrows follow call direction
    expect(d.edges).toContainEqual(expect.objectContaining({ source: "L:X", target: "C" }));
    expect(d.edges).toContainEqual(expect.objectContaining({ source: "C", target: "R:Y" }));
  });

  it("shows a dual-role symbol once per side", () => {
    // B calls A and A calls B
    const g = makeGraph(["A", "B"], [["B", "A"], ["A", "B"]]);
    const d = buildButterfly(g, "A", 1, new Set(), NO_HISTORY);
    const els = d.nodes.map((n) => n.elId).sort();
    expect(els).toEqual(["C", "L:B", "R:B"]);
  });

  it("renders direct recursion as a C→C self-loop and terminates", () => {
    const g = makeGraph(["A"], [["A", "A"]]);
    const d = buildButterfly(g, "A", 3, new Set(), NO_HISTORY);
    expect(d.nodes.map((n) => n.elId)).toEqual(["C"]);
    const loops = d.edges.filter((e) => e.source === "C" && e.target === "C");
    expect(loops).toHaveLength(1);
  });

  it("never materializes the center inside a wing on deeper cycles", () => {
    // A → B → A: B is callee tier 1 and caller tier 1; center must not
    // reappear at tier 2 of either wing.
    const g = makeGraph(["A", "B"], [["A", "B"], ["B", "A"]]);
    const d = buildButterfly(g, "A", 3, new Set(), NO_HISTORY);
    expect(d.nodes.filter((n) => n.symbolId === "A")).toHaveLength(1);
  });

  it("assigns BFS-minimal tiers", () => {
    // A → B → C and A → C: C is reachable at tier 1, must be tier 1.
    const g = makeGraph(["A", "B", "C"], [["A", "B"], ["B", "C"], ["A", "C"]]);
    const d = buildButterfly(g, "A", 3, new Set(), NO_HISTORY);
    const c = d.nodes.find((n) => n.elId === "R:C");
    expect(c?.tier).toBe(1);
  });

  it("assigns order and colCount per column", () => {
    const g = makeGraph(["A", "X", "Y", "Z"], [["A", "X"], ["A", "Y"], ["A", "Z"]]);
    const d = buildButterfly(g, "A", 1, new Set(), NO_HISTORY);
    const col = d.nodes.filter((n) => n.side === "callee" && n.tier === 1);
    expect(col).toHaveLength(3);
    expect(col.map((n) => n.order).sort()).toEqual([0, 1, 2]);
    expect(col.every((n) => n.colCount === 3)).toBe(true);
  });

  it("caps node count and reports truncation", () => {
    const callees = Array.from({ length: 20 }, (_, i) => `T${i}`);
    const g = makeGraph(["A", ...callees], callees.map((t) => ["A", t] as [string, string]));
    const d = buildButterfly(g, "A", 1, new Set(), NO_HISTORY, 10); // 5 per side
    expect(d.truncated).toBe(true);
    expect(d.nodes.filter((n) => n.side === "callee")).toHaveLength(5);
  });

  it("excludes the center from visitedIds and passes history flags through", () => {
    const g = makeGraph(["A", "B"], [["A", "B"]]);
    const d = buildButterfly(g, "A", 1, new Set(["A", "B"]), { back: true, fwd: false });
    expect(d.visitedIds).toEqual(["B"]);
    expect(d.canGoBack).toBe(true);
    expect(d.canGoForward).toBe(false);
  });

  it("returns an empty shell for an unknown center", () => {
    const g = makeGraph(["A"], []);
    const d = buildButterfly(g, "Nope", 2, new Set(), NO_HISTORY);
    expect(d.nodes).toEqual([]);
    expect(d.edges).toEqual([]);
    expect(d.centerLabel).toBe("Nope");
  });
});
