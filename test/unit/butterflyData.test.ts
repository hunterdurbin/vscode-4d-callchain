import { describe, expect, it } from "vitest";
import { CallGraph, SymbolKind, CallKind, INDEX_VERSION } from "../../packages/core/dist";
import type { SymbolIndex, SymbolRecord, CallEdge } from "../../packages/core/dist";
import {
  buildButterfly,
  defaultButterflyOptions,
  normalizeButterflyOptions,
  callSiteSortApplicable,
  chipKeyOf,
  formatSignature
} from "../../packages/vscode-client/src/views/graphView/butterflyData";
import type { ButterflyOptions, ButterflyNode } from "../../packages/vscode-client/src/views/graphView/butterflyData";

const SEP = ""; // tree-mode path separator inside element ids

function sym(id: string, name: string, kind: SymbolKind = SymbolKind.ProjectMethod, extras: Partial<SymbolRecord> = {}): SymbolRecord {
  return { id, name, kind, location: { uri: `file:///${name}`, line: 0 }, ...extras };
}

function edge(fromId: string, toId: string, line = 0, o: Partial<CallEdge> = {}): CallEdge {
  return { fromId, toId, callKind: CallKind.Static, line, raw: "", resolved: true, ...o };
}

function makeGraph(symbols: (string | SymbolRecord)[], edges: CallEdge[]): CallGraph {
  const idx: SymbolIndex = {
    version: INDEX_VERSION,
    builtAt: 0,
    projectRoot: "/tmp/x",
    symbols: [],
    edges: [],
    fileMtimes: {}
  };
  const g = new CallGraph(idx);
  for (const s of symbols) g.addSymbol(typeof s === "string" ? sym(s, s) : s);
  for (const e of edges) g.addEdge(e);
  return g;
}

function opts(o: Partial<ButterflyOptions> = {}): ButterflyOptions {
  return { ...defaultButterflyOptions(2), ...o };
}

const NO_HISTORY = { back: false, fwd: false };

function build(g: CallGraph, centerId: string, o: Partial<ButterflyOptions> = {}, cap = 400) {
  return buildButterfly(g, centerId, opts(o), new Set(), NO_HISTORY, cap);
}

function node(d: { nodes: ButterflyNode[] }, elId: string): ButterflyNode | undefined {
  return d.nodes.find((n) => n.elId === elId);
}

describe("buildButterfly baseline", () => {
  it("places callers strictly left and callees strictly right", () => {
    const g = makeGraph(["A", "X", "Y"], [edge("X", "A"), edge("A", "Y")]);
    const d = build(g, "A");
    expect(node(d, "C")?.symbolId).toBe("A");
    expect(node(d, "L:X")?.side).toBe("caller");
    expect(node(d, "R:Y")?.side).toBe("callee");
    expect(d.nodes.filter((n) => n.side === "caller").every((n) => n.elId.startsWith("L"))).toBe(true);
    expect(d.nodes.filter((n) => n.side === "callee").every((n) => n.elId.startsWith("R"))).toBe(true);
    expect(d.edges).toContainEqual(expect.objectContaining({ source: "L:X", target: "C" }));
    expect(d.edges).toContainEqual(expect.objectContaining({ source: "C", target: "R:Y" }));
  });

  it("shows a dual-role symbol once per side", () => {
    const g = makeGraph(["A", "B"], [edge("B", "A"), edge("A", "B")]);
    const d = build(g, "A", { callerDepth: 1, calleeDepth: 1 });
    expect(d.nodes.map((n) => n.elId).sort()).toEqual(["C", "L:B", "R:B"]);
  });

  it("renders direct recursion as a single C→C self-loop and terminates", () => {
    const g = makeGraph(["A"], [edge("A", "A")]);
    const d = build(g, "A", { callerDepth: 3, calleeDepth: 3 });
    expect(d.nodes.map((n) => n.elId)).toEqual(["C"]);
    expect(d.edges.filter((e) => e.source === "C" && e.target === "C")).toHaveLength(1);
  });

  it("never materializes the center inside a wing on deeper cycles", () => {
    const g = makeGraph(["A", "B"], [edge("A", "B"), edge("B", "A")]);
    const d = build(g, "A", { callerDepth: 3, calleeDepth: 3 });
    expect(d.nodes.filter((n) => n.symbolId === "A")).toHaveLength(1);
  });

  it("assigns BFS-minimal tiers in graph mode", () => {
    const g = makeGraph(["A", "B", "C"], [edge("A", "B"), edge("B", "C"), edge("A", "C")]);
    const d = build(g, "A", { calleeDepth: 3 });
    expect(node(d, "R:C")?.tier).toBe(1);
  });

  it("assigns centered rows per column", () => {
    const g = makeGraph(["A", "X", "Y", "Z"], [edge("A", "X"), edge("A", "Y"), edge("A", "Z")]);
    const d = build(g, "A", { calleeDepth: 1 });
    const col = d.nodes.filter((n) => n.side === "callee" && n.tier === 1);
    expect(col).toHaveLength(3);
    // Alphabetical: X, Y, Z top to bottom, centered on the midline.
    expect(col.map((n) => [n.symbolId, n.row])).toEqual([
      ["X", -1],
      ["Y", 0],
      ["Z", 1]
    ]);
  });

  it("caps node count and reports truncation", () => {
    const callees = Array.from({ length: 20 }, (_, i) => `T${i}`);
    const g = makeGraph(["A", ...callees], callees.map((t) => edge("A", t)));
    const d = build(g, "A", { calleeDepth: 1 }, 10); // 5 per side
    expect(d.truncated).toBe(true);
    expect(d.nodes.filter((n) => n.side === "callee")).toHaveLength(5);
  });

  it("excludes the center from visitedIds and passes history flags through", () => {
    const g = makeGraph(["A", "B"], [edge("A", "B")]);
    const d = buildButterfly(g, "A", opts(), new Set(["A", "B"]), { back: true, fwd: false });
    expect(d.visitedIds).toEqual(["B"]);
    expect(d.canGoBack).toBe(true);
    expect(d.canGoForward).toBe(false);
  });

  it("returns an empty shell for an unknown center", () => {
    const g = makeGraph(["A"], []);
    const d = build(g, "Nope");
    expect(d.nodes).toEqual([]);
    expect(d.edges).toEqual([]);
    expect(d.centerLabel).toBe("Nope");
  });
});

describe("unreachable calls", () => {
  it("gray mode flags unresolved, dynamic and formula edges plus Unresolved targets", () => {
    const g = makeGraph(
      ["A", "B", "Dy", "Fo", sym("U", "U", SymbolKind.Unresolved)],
      [
        edge("A", "B", 0, { resolved: false }),
        edge("A", "Dy", 1, { callKind: CallKind.Dynamic }),
        edge("A", "Fo", 2, { callKind: CallKind.Formula }),
        edge("A", "U", 3)
      ]
    );
    const d = build(g, "A", { unreachable: "gray" });
    expect(d.edges.filter((e) => e.unreachable)).toHaveLength(4);
    expect(node(d, "R:U")?.unreachable).toBe(true);
    expect(node(d, "R:B")?.unreachable).toBeUndefined(); // node itself is fine, only its edge is uncertain
  });

  it("hide mode removes the node and the subtree behind it", () => {
    const g = makeGraph(
      ["A", "B", "V", "W"],
      [edge("A", "B", 0, { resolved: false }), edge("B", "V"), edge("A", "W")]
    );
    const d = build(g, "A", { unreachable: "hide", calleeDepth: 3 });
    expect(node(d, "R:B")).toBeUndefined();
    expect(node(d, "R:V")).toBeUndefined();
    expect(node(d, "R:W")).toBeDefined();
    expect(d.edges.some((e) => e.unreachable)).toBe(false);
  });
});

describe("class hiding", () => {
  const clsSym = (id: string, owner: string) => sym(id, id, SymbolKind.ClassFunction, { ownerClass: owner });

  it("replaces a hidden mid-chain node with a pass-through stub", () => {
    const g = makeGraph(["A", clsSym("B", "X"), "V"], [edge("A", "B"), edge("B", "V")]);
    const d = build(g, "A", { hiddenClasses: ["X"], calleeDepth: 2 });
    const stub = node(d, "R:B");
    expect(stub?.stub).toBe(true);
    expect(stub?.symbolId).toBe(""); // taps are no-ops on stubs
    expect(stub?.label).toBe("");
    expect(stub?.hiddenLabels).toEqual(["B"]);
    expect(d.edges).toContainEqual(expect.objectContaining({ source: "C", target: "R:B" }));
    expect(d.edges).toContainEqual(expect.objectContaining({ source: "R:B", target: "R:V" }));
  });

  it("removes hidden leaves entirely", () => {
    const g = makeGraph(["A", clsSym("B", "X")], [edge("A", "B")]);
    const d = build(g, "A", { hiddenClasses: ["X"] });
    expect(d.nodes.map((n) => n.elId)).toEqual(["C"]);
    expect(d.edges).toEqual([]);
  });

  it("merges a chain of hidden nodes into one stub", () => {
    const g = makeGraph(
      ["A", clsSym("B", "X"), clsSym("B2", "X"), "V"],
      [edge("A", "B"), edge("B", "B2"), edge("B2", "V")]
    );
    const d = build(g, "A", { hiddenClasses: ["X"], calleeDepth: 3 });
    const stubs = d.nodes.filter((n) => n.stub);
    expect(stubs).toHaveLength(1);
    expect(stubs[0].elId).toBe("R*0");
    expect(stubs[0].hiddenLabels).toEqual(["B", "B2"]);
    expect(d.edges).toContainEqual(expect.objectContaining({ source: "C", target: "R*0" }));
    expect(d.edges).toContainEqual(expect.objectContaining({ source: "R*0", target: "R:V" }));
  });

  it("reports class chips with pre-hide counts and absent persisted keys", () => {
    const g = makeGraph(
      ["A", clsSym("B", "X"), clsSym("B2", "X"), "V"],
      [edge("A", "B"), edge("B", "B2"), edge("B2", "V")]
    );
    const d = build(g, "A", { hiddenClasses: ["X", "Ghost"], calleeDepth: 3 });
    const x = d.classChips.find((c) => c.key === "X");
    expect(x).toMatchObject({ count: 2, hidden: true, present: true });
    expect(d.classChips.find((c) => c.key === "Ghost")).toMatchObject({ count: 0, hidden: true, present: false });
    expect(d.classChips.find((c) => c.key === "(top-level)")).toMatchObject({ count: 1, hidden: false });
  });

  it("groups builtins and constants under synthetic chips", () => {
    expect(chipKeyOf(sym("b", "b", SymbolKind.Builtin))).toBe("(builtins)");
    expect(chipKeyOf(sym("c", "c", SymbolKind.Constant))).toBe("(constants)");
    expect(chipKeyOf(sym("m", "m"))).toBe("(top-level)");
    expect(chipKeyOf(sym("f", "f", SymbolKind.ClassFunction, { ownerClass: "Boat" }))).toBe("Boat");
  });
});

describe("pass-through compression", () => {
  it("compresses a 1-in/1-out node into a stub", () => {
    const g = makeGraph(["A", "M", "V"], [edge("A", "M"), edge("M", "V")]);
    const d = build(g, "A", { compressPassThrough: true, calleeDepth: 2 });
    expect(node(d, "R:M")?.stub).toBe(true);
  });

  it("keeps nodes with two distinct inward neighbors", () => {
    const g = makeGraph(["A", "M", "N", "V"], [edge("A", "M"), edge("A", "N"), edge("N", "M"), edge("M", "V")]);
    const d = build(g, "A", { compressPassThrough: true, calleeDepth: 3 });
    expect(node(d, "R:M")?.stub).toBeUndefined();
  });

  it("ignores self-loops when counting degree", () => {
    const g = makeGraph(["A", "M", "V"], [edge("A", "M"), edge("M", "M"), edge("M", "V")]);
    const d = build(g, "A", { compressPassThrough: true, calleeDepth: 2 });
    expect(node(d, "R:M")?.stub).toBe(true);
  });

  it("treats parallel call sites as one pair — dupEdges mode never changes compression", () => {
    const g = makeGraph(["A", "M", "V"], [edge("A", "M", 1), edge("A", "M", 2), edge("M", "V")]);
    for (const dupEdges of ["collapse", "expand"] as const) {
      const d = build(g, "A", { compressPassThrough: true, dupEdges, calleeDepth: 2 });
      expect(node(d, "R:M")?.stub).toBe(true);
    }
  });

  it("merges a pass-through stub with an adjacent class-hide stub", () => {
    const g = makeGraph(
      ["A", sym("H", "H", SymbolKind.ClassFunction, { ownerClass: "X" }), "M", "V"],
      [edge("A", "H"), edge("H", "M"), edge("M", "V")]
    );
    const d = build(g, "A", { hiddenClasses: ["X"], compressPassThrough: true, calleeDepth: 3 });
    const stubs = d.nodes.filter((n) => n.stub);
    expect(stubs).toHaveLength(1);
    expect(stubs[0].hiddenLabels).toEqual(["H", "M"]);
    expect(d.edges).toContainEqual(expect.objectContaining({ source: "C", target: stubs[0].elId }));
    expect(d.edges).toContainEqual(expect.objectContaining({ source: stubs[0].elId, target: "R:V" }));
  });
});

describe("duplicate edges", () => {
  it("collapse mode renders one edge per pair without line numbers", () => {
    const g = makeGraph(["A", "B"], [edge("A", "B", 5), edge("A", "B", 9)]);
    const d = build(g, "A", { dupEdges: "collapse" });
    const between = d.edges.filter((e) => e.source === "C" && e.target === "R:B");
    expect(between).toHaveLength(1);
    expect(between[0].line).toBeUndefined();
  });

  it("expand mode renders one edge per call site with 1-based lines, sorted", () => {
    const g = makeGraph(["A", "B"], [edge("A", "B", 9), edge("A", "B", 5)]);
    const d = build(g, "A", { dupEdges: "expand" });
    const between = d.edges.filter((e) => e.source === "C" && e.target === "R:B");
    expect(between.map((e) => e.line)).toEqual([6, 10]);
  });

  it("keeps the caller as the edge source on the caller wing (badge sits at the call site)", () => {
    const g = makeGraph(["A", "X"], [edge("X", "A", 7)]);
    const d = build(g, "A", { dupEdges: "expand" });
    expect(d.edges).toContainEqual(expect.objectContaining({ source: "L:X", target: "C", line: 8 }));
  });
});

describe("sort modes", () => {
  it("minimize-crossings uncrosses a two-column fixture deterministically", () => {
    // Alphabetical start: tier1 [P, Q], tier2 [x, y]; P→y and Q→x cross.
    const g = makeGraph(["A", "P", "Q", "x", "y"], [edge("A", "P"), edge("A", "Q"), edge("P", "y"), edge("Q", "x")]);
    const run = () => build(g, "A", { sort: "minCross", calleeDepth: 2 });
    const d = run();
    const y = node(d, "R:y") as ButterflyNode;
    const x = node(d, "R:x") as ButterflyNode;
    const p = node(d, "R:P") as ButterflyNode;
    const q = node(d, "R:Q") as ButterflyNode;
    // y follows P, x follows Q — same vertical order in both columns.
    expect(Math.sign(y.row - x.row)).toBe(Math.sign(p.row - q.row));
    expect(run().nodes).toEqual(d.nodes); // deterministic
  });

  it("call-site sort orders tree children by source line", () => {
    // Alphabetical would put A1 first; call order is Z1 (line 5) then A1 (line 10).
    const g = makeGraph(["M", "A1", "Z1"], [edge("M", "Z1", 5), edge("M", "A1", 10)]);
    const d = build(g, "M", { sort: "callSite", calleeMode: "tree" });
    const z = node(d, "R:Z1") as ButterflyNode;
    const a = node(d, "R:A1") as ButterflyNode;
    expect(z.row).toBeLessThan(a.row);
  });

  it("falls back to alphabetical on a merged-graph wing with collapsed duplicates", () => {
    const g = makeGraph(["M", "A1", "Z1"], [edge("M", "Z1", 5), edge("M", "A1", 10)]);
    const d = build(g, "M", { sort: "callSite", calleeMode: "graph", dupEdges: "collapse" });
    const z = node(d, "R:Z1") as ButterflyNode;
    const a = node(d, "R:A1") as ButterflyNode;
    expect(a.row).toBeLessThan(z.row);
  });

  it("callSiteSortApplicable mirrors the UI disable rule", () => {
    expect(callSiteSortApplicable(opts({ callerMode: "graph", calleeMode: "graph", dupEdges: "collapse" }))).toBe(false);
    expect(callSiteSortApplicable(opts({ callerMode: "graph", calleeMode: "graph", dupEdges: "expand" }))).toBe(true);
    expect(callSiteSortApplicable(opts({ callerMode: "tree", calleeMode: "graph", dupEdges: "collapse" }))).toBe(true);
    expect(callSiteSortApplicable(opts({ callerMode: "graph", calleeMode: "treeLeft", dupEdges: "collapse" }))).toBe(true);
  });
});

describe("tree mode", () => {
  it("duplicates a diamond-shared node once per path with path-based element ids", () => {
    const g = makeGraph(["A", "B", "P", "D"], [edge("A", "B"), edge("A", "P"), edge("B", "D"), edge("P", "D")]);
    const d = build(g, "A", { calleeMode: "tree", calleeDepth: 2 });
    const copies = d.nodes.filter((n) => n.symbolId === "D");
    expect(copies).toHaveLength(2);
    expect(copies.map((n) => n.elId).sort()).toEqual([`R:B${SEP}D`, `R:P${SEP}D`]);
  });

  it("centers a parent on its children (tidy layout)", () => {
    const g = makeGraph(["A", "B", "D", "E"], [edge("A", "B"), edge("B", "D"), edge("B", "E")]);
    const d = build(g, "A", { calleeMode: "tree", calleeDepth: 2 });
    const b = node(d, "R:B") as ButterflyNode;
    const kids = d.nodes.filter((n) => n.tier === 2 && n.side === "callee");
    expect(b.row).toBe((kids[0].row + kids[1].row) / 2);
  });

  it("cuts cycles and marks the node recursive", () => {
    const g = makeGraph(["A", "B", "K"], [edge("A", "B"), edge("B", "K"), edge("K", "B")]);
    const d = build(g, "A", { calleeMode: "tree", calleeDepth: 5 });
    const k = node(d, `R:B${SEP}K`) as ButterflyNode;
    expect(k.recursive).toBe(true);
    expect(k.label.endsWith("↻")).toBe(true);
    expect(d.nodes.filter((n) => n.symbolId === "B")).toHaveLength(1); // no infinite unroll
  });
});

describe("tree-from-the-left mode", () => {
  it("shows a shared entry point once, in the outermost column", () => {
    // main→f→A and main→g→A (A is the center).
    const g = makeGraph(["A", "f", "g", "main"], [edge("f", "A"), edge("g", "A"), edge("main", "f"), edge("main", "g")]);
    const d = build(g, "A", { callerMode: "treeLeft", callerDepth: 3 });
    const mains = d.nodes.filter((n) => n.symbolId === "main");
    expect(mains).toHaveLength(1);
    const f = d.nodes.find((n) => n.symbolId === "f") as ButterflyNode;
    expect(mains[0].tier).toBeGreaterThan(f.tier);
    expect(f.tier).toBe(1);
    // Call direction still reads outer → inner → center.
    expect(d.edges).toContainEqual(expect.objectContaining({ source: mains[0].elId, target: f.elId }));
    expect(d.edges).toContainEqual(expect.objectContaining({ source: f.elId, target: "C" }));
  });

  it("lets a node be both terminal and internal (duplication migrates to the center)", () => {
    // Paths [A2, B2] and [X2, A2, B2]: trie B2 → A2 → X2; A2 both continues
    // to X2 and terminates (it calls the center directly).
    const g = makeGraph(
      ["Ctr", "A2", "B2", "X2"],
      [edge("A2", "Ctr"), edge("B2", "A2"), edge("X2", "Ctr"), edge("A2", "X2")]
    );
    const d = build(g, "Ctr", { callerMode: "treeLeft", callerDepth: 3 });
    expect(d.nodes.filter((n) => n.symbolId === "B2")).toHaveLength(1);
    const a2 = d.nodes.find((n) => n.symbolId === "A2") as ButterflyNode;
    const x2 = d.nodes.find((n) => n.symbolId === "X2") as ButterflyNode;
    const b2 = d.nodes.find((n) => n.symbolId === "B2") as ButterflyNode;
    expect(d.edges).toContainEqual(expect.objectContaining({ source: b2.elId, target: a2.elId }));
    expect(d.edges).toContainEqual(expect.objectContaining({ source: a2.elId, target: x2.elId }));
    expect(d.edges).toContainEqual(expect.objectContaining({ source: a2.elId, target: "C" }));
    expect(d.edges).toContainEqual(expect.objectContaining({ source: x2.elId, target: "C" }));
    // Tier formula D + 1 − trieDepth: B2 depth 1 → tier 3; A2 → 2; X2 → 1.
    expect([b2.tier, a2.tier, x2.tier]).toEqual([3, 2, 1]);
  });
});

describe("labels and signatures", () => {
  it("formats plain functions, getters, setters and constructors", () => {
    expect(
      formatSignature(
        sym("f", "setBoat", SymbolKind.ClassFunction, {
          params: [{ name: "$b", type: "cs.Boat" }],
          returnType: "Boolean"
        })
      )
    ).toBe("setBoat($b : cs.Boat) : Boolean");
    expect(formatSignature(sym("g", "name", SymbolKind.ClassGetter, { accessor: "get", returnType: "Text" }))).toBe(
      "get name : Text"
    );
    expect(
      formatSignature(sym("s", "name", SymbolKind.ClassSetter, { accessor: "set", params: [{ name: "$v", type: "Text" }] }))
    ).toBe("set name($v : Text)");
    expect(
      formatSignature(sym("c", "constructor", SymbolKind.ClassConstructor, { ownerClass: "Boat", params: [] }))
    ).toBe("new Boat()");
    expect(
      formatSignature(sym("v", "min", SymbolKind.ProjectMethod, { params: [{ name: "$1", type: "Integer", variadic: true }] }))
    ).toBe("min($1 : Integer…)");
    expect(formatSignature(sym("p", "plain"))).toBe("plain");
  });

  it("label mode 'type' renders signatures on nodes", () => {
    const g = makeGraph(
      ["A", sym("B", "fn", SymbolKind.ClassFunction, { params: [{ name: "$x", type: "Integer" }], returnType: "Text" })],
      [edge("A", "B")]
    );
    const d = build(g, "A", { label: "type" });
    expect(node(d, "R:B")?.label).toBe("fn($x : Integer) : Text");
  });
});

describe("options normalization", () => {
  it("round-trips a full object", () => {
    const o = opts({ sort: "minCross", callerDepth: 3, hiddenClasses: ["X"], callerMode: "tree" });
    expect(normalizeButterflyOptions(JSON.parse(JSON.stringify(o)), 1)).toEqual(o);
  });

  it("clamps depths and rejects bogus enums", () => {
    const n = normalizeButterflyOptions({ callerDepth: 99, calleeDepth: 0, sort: "zigzag", callerMode: "spiral" }, 2);
    expect(n.callerDepth).toBe(6);
    expect(n.calleeDepth).toBe(1);
    expect(n.sort).toBe("alpha");
    expect(n.callerMode).toBe("graph");
  });

  it("returns seeded defaults for undefined input", () => {
    const n = normalizeButterflyOptions(undefined, 4);
    expect(n).toEqual(defaultButterflyOptions(4));
    expect(n.callerDepth).toBe(4);
    expect(n.calleeDepth).toBe(4);
  });
});
