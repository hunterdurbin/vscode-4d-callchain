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

// ── Polymorphic dispatch (receiver-aware resolution) ─────────────────────────

function classSym(name: string, extendsClass?: string): SymbolRecord {
  return {
    id: `Class:${name}`,
    name,
    kind: SymbolKind.Class,
    location: { uri: `file:///${name}.4dm`, line: 0 },
    ...(extendsClass ? { extendsClass } : {})
  };
}

function memberSym(owner: string, name: string, kind: SymbolKind = SymbolKind.ClassFunction): SymbolRecord {
  return {
    id: `${kind}:${owner}.${name}`,
    name,
    kind,
    ownerClass: owner,
    location: { uri: `file:///${owner}.4dm`, line: 1 }
  };
}

function unresolvedSym(name: string): SymbolRecord {
  return {
    id: `Unresolved:${name}`,
    name,
    kind: SymbolKind.Unresolved,
    location: { uri: "", line: 0 }
  };
}

function dEdge(
  fromId: string,
  toId: string,
  opts: Partial<CallEdge> = {}
): CallEdge {
  return {
    fromId,
    toId,
    callKind: CallKind.Static,
    line: 0,
    raw: "",
    resolved: true,
    ...opts
  };
}

function dispatchGraph(symbols: SymbolRecord[], edges: CallEdge[]): CallGraph {
  const idx: SymbolIndex = {
    version: INDEX_VERSION,
    builtAt: 0,
    projectRoot: "/tmp/x",
    symbols: [],
    edges: [],
    fileMtimes: {}
  };
  const g = new CallGraph(idx);
  for (const s of symbols) g.addSymbol(s);
  for (const e of edges) g.addEdge(e);
  return g;
}

// Animal ← Dog hierarchy: Animal.template calls This.hook; Dog overrides hook.
const HIERARCHY = [
  classSym("Animal"),
  classSym("Dog", "Animal"),
  memberSym("Dog", "run"),
  memberSym("Animal", "template"),
  memberSym("Animal", "hook"),
  memberSym("Dog", "hook")
];

describe("buildTraceChildren — polymorphic dispatch", () => {
  it("re-resolves This.hook against the pinned receiver class (template method)", () => {
    const g = dispatchGraph(HIERARCHY, [
      dEdge("ClassFunction:Dog.run", "ClassFunction:Animal.template", {
        callKind: CallKind.Inherited, receiver: "this", line: 1
      }),
      dEdge("ClassFunction:Animal.template", "ClassFunction:Animal.hook", {
        receiver: "this", line: 2
      })
    ]);
    const rows = buildTraceChildren(
      g, "ClassFunction:Dog.run", new Set(["ClassFunction:Dog.run"]), 2, counter(), { left: 100 }, "Dog"
    );
    const hook = rows[0].children![0];
    expect(hook.calleeId).toBe("ClassFunction:Dog.hook");
    expect(hook.dispatched).toBe(true);
    expect(hook.staticLabel).toBe("Animal.hook");
    expect(hook.staticCalleeId).toBe("ClassFunction:Animal.hook");
    expect(hook.receiverClass).toBe("Dog");
    expect(hook.alternatives).toBeUndefined();
  });

  it("rooted at the base class: static row plus may-run alternatives", () => {
    const g = dispatchGraph(HIERARCHY, [
      dEdge("ClassFunction:Animal.template", "ClassFunction:Animal.hook", {
        receiver: "this", line: 2, raw: "This.hook()"
      })
    ]);
    const rows = buildTraceChildren(
      g, "ClassFunction:Animal.template", new Set(["ClassFunction:Animal.template"]), 1, counter(), { left: 100 }, "Animal"
    );
    const hook = rows[0];
    expect(hook.calleeId).toBe("ClassFunction:Animal.hook");
    expect(hook.dispatched).toBeUndefined();
    expect(hook.alternatives).toHaveLength(1);
    const alt = hook.alternatives![0];
    expect(alt.calleeId).toBe("ClassFunction:Dog.hook");
    expect(alt.isAlternative).toBe(true);
    expect(alt.receiverClass).toBe("Dog");
    expect(alt.fromId).toBe("ClassFunction:Animal.template");
    expect(alt.line).toBe(2);
    expect(alt.raw).toBe("This.hook()");
  });

  it("abstract hook (unresolved): pinned subclass dispatches; pinned base shows alternatives", () => {
    const syms = [
      classSym("Animal"),
      classSym("Dog", "Animal"),
      memberSym("Dog", "run"),
      memberSym("Animal", "template"),
      memberSym("Dog", "hook"),
      unresolvedSym("This.hook")
    ];
    const edges = [
      dEdge("ClassFunction:Dog.run", "ClassFunction:Animal.template", {
        callKind: CallKind.Inherited, receiver: "this", line: 1
      }),
      dEdge("ClassFunction:Animal.template", "Unresolved:This.hook", {
        callKind: CallKind.Dynamic, receiver: "this", resolved: false, line: 2
      })
    ];

    // Pinned Dog (trace entered via Dog.run): dispatches to the override.
    let g = dispatchGraph(syms, edges);
    let rows = buildTraceChildren(
      g, "ClassFunction:Dog.run", new Set(["ClassFunction:Dog.run"]), 2, counter(), { left: 100 }, "Dog"
    );
    const viaDog = rows[0].children![0];
    expect(viaDog.calleeId).toBe("ClassFunction:Dog.hook");
    expect(viaDog.dispatched).toBe(true);
    expect(viaDog.resolved).toBe(true);

    // Pinned Animal (trace rooted at the base): unresolved row + alternatives.
    g = dispatchGraph(syms, edges);
    rows = buildTraceChildren(
      g, "ClassFunction:Animal.template", new Set(["ClassFunction:Animal.template"]), 1, counter(), { left: 100 }, "Animal"
    );
    const abstractRow = rows[0];
    expect(abstractRow.calleeId).toBe("Unresolved:This.hook");
    expect(abstractRow.resolved).toBe(false);
    expect(abstractRow.alternatives!.map((a) => a.calleeId)).toEqual(["ClassFunction:Dog.hook"]);
  });

  it("super edges never re-resolve but keep the receiver pinned inside", () => {
    const g = dispatchGraph(HIERARCHY, [
      // Dog.hook calls Super.hook → must stay Animal.hook (parent impl runs)...
      dEdge("ClassFunction:Dog.hook", "ClassFunction:Animal.hook", {
        callKind: CallKind.Inherited, receiver: "super", line: 1
      }),
      // ...but a This.template inside Animal.hook still sees the Dog pin —
      // and template has no Dog override, so it resolves statically.
      dEdge("ClassFunction:Animal.hook", "ClassFunction:Animal.template", {
        receiver: "this", line: 2
      }),
      // And This.hook inside Animal.template dispatches back to Dog.hook.
      dEdge("ClassFunction:Animal.template", "ClassFunction:Animal.hook", {
        receiver: "this", line: 3
      })
    ]);
    const rows = buildTraceChildren(
      g, "ClassFunction:Dog.hook", new Set(["ClassFunction:Dog.hook"]), 3, counter(), { left: 100 }, "Dog"
    );
    const superRow = rows[0];
    expect(superRow.calleeId).toBe("ClassFunction:Animal.hook");
    expect(superRow.dispatched).toBeUndefined();
    expect(superRow.alternatives).toBeUndefined(); // super target is exact
    expect(superRow.receiverClass).toBe("Dog"); // pin survives
    const templateRow = superRow.children![0];
    expect(templateRow.calleeId).toBe("ClassFunction:Animal.template");
    const hookAgain = templateRow.children![0];
    expect(hookAgain.calleeId).toBe("ClassFunction:Dog.hook");
    expect(hookAgain.dispatched).toBe(true);
    expect(hookAgain.recursive).toBe(true); // Dog.hook is the trace root
  });

  it("dispatches getter reads and setter writes by slot", () => {
    const syms = [
      classSym("Animal"),
      classSym("Dog", "Animal"),
      memberSym("Animal", "template"),
      memberSym("Animal", "label", SymbolKind.ClassGetter),
      memberSym("Dog", "label", SymbolKind.ClassGetter),
      memberSym("Animal", "label", SymbolKind.ClassSetter),
      memberSym("Dog", "label", SymbolKind.ClassSetter)
    ];
    const g = dispatchGraph(syms, [
      dEdge("ClassFunction:Animal.template", "ClassGetter:Animal.label", {
        receiver: "this", access: "read", line: 1
      }),
      dEdge("ClassFunction:Animal.template", "ClassSetter:Animal.label", {
        receiver: "this", access: "write", line: 2
      })
    ]);
    const rows = buildTraceChildren(
      g, "ClassFunction:Animal.template", new Set(["ClassFunction:Animal.template"]), 1, counter(), { left: 100 }, "Dog"
    );
    expect(rows[0].calleeId).toBe("ClassGetter:Dog.label");
    expect(rows[0].dispatched).toBe(true);
    expect(rows[1].calleeId).toBe("ClassSetter:Dog.label");
    expect(rows[1].dispatched).toBe(true);
  });

  it("marks recursion on the effective (dispatched) id", () => {
    const g = dispatchGraph(HIERARCHY, [
      dEdge("ClassFunction:Animal.template", "ClassFunction:Animal.hook", {
        receiver: "this", line: 1
      })
    ]);
    // Dog.hook is already in the ancestor chain → the dispatched row is recursive.
    const rows = buildTraceChildren(
      g,
      "ClassFunction:Animal.template",
      new Set(["ClassFunction:Dog.hook", "ClassFunction:Animal.template"]),
      5,
      counter(),
      { left: 100 },
      "Dog"
    );
    expect(rows[0].calleeId).toBe("ClassFunction:Dog.hook");
    expect(rows[0].recursive).toBe(true);
    expect(rows[0].children).toBeUndefined();
  });

  it("untagged edges into a class switch the receiver; global methods clear it", () => {
    const syms = [
      ...HIERARCHY,
      sym("M", "M"),
      sym("Helper", "Helper")
    ];
    const g = dispatchGraph(syms, [
      // M (project method) → Animal.template: receiver becomes Animal.
      dEdge("M", "ClassFunction:Animal.template", { line: 1 }),
      // Animal.template → Helper (project method): pin cleared inside Helper.
      dEdge("ClassFunction:Animal.template", "Helper", { line: 2 })
    ]);
    const rows = buildTraceChildren(g, "M", new Set(["M"]), 2, counter(), { left: 100 }, undefined);
    const template = rows[0];
    expect(template.receiverClass).toBe("Animal");
    // Alternatives apply: Dog could be the runtime type behind a base-typed call.
    // template itself has no Dog override here, so none expected for the row,
    // but the helper child must have no receiver.
    const helper = template.children![0];
    expect(helper.receiverClass).toBeUndefined();
  });

  it("alternatives consume budget and stop when exhausted", () => {
    const subclasses = Array.from({ length: 5 }, (_, i) => `Sub${i}`);
    const syms = [
      classSym("Animal"),
      ...subclasses.map((s) => classSym(s, "Animal")),
      memberSym("Animal", "template"),
      memberSym("Animal", "hook"),
      ...subclasses.map((s) => memberSym(s, "hook"))
    ];
    const g = dispatchGraph(syms, [
      dEdge("ClassFunction:Animal.template", "ClassFunction:Animal.hook", {
        receiver: "this", line: 1
      })
    ]);
    const budget = { left: 3 }; // 1 main row + 2 alternatives
    const rows = buildTraceChildren(
      g, "ClassFunction:Animal.template", new Set(["ClassFunction:Animal.template"]), 1, counter(), budget, "Animal"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].alternatives).toHaveLength(2);
    expect(budget.left).toBe(0);
  });
});
