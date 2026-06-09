import {
  CallEdge,
  CallGraph,
  ClassFlavor,
  SymbolKind,
  SymbolRecord,
  descendantClasses,
  directSubclasses,
  findOverriddenFunction,
  findOverridesOfFunction,
  fuzzyMatch,
  inheritedFunctions,
  dispatchCallers,
  symbolIdFor
} from "@4d/core";
import { SymbolSummary, summarize, summarizeEdge } from "./format.js";
import { resolveSymbol, SymbolSelector } from "./resolve.js";

/** Returned in place of data when a selector matched nothing or was ambiguous. */
export interface QueryError {
  error: string;
  candidates?: SymbolSummary[];
}

export function isQueryError(v: unknown): v is QueryError {
  return typeof v === "object" && v !== null && "error" in v;
}

/**
 * Collapse duplicate call edges that point at the same node from the same
 * call site — keyed by `(otherId, line, column)`. A continued or re-resolved
 * statement can, in some index states, emit the same logical edge more than
 * once (identical target/line/column, differing only in callKind/resolved);
 * those inflate counts and clutter output. Genuinely distinct calls to the
 * same target on one line keep different columns, so they survive. When a
 * collision happens we keep the `resolved` edge if either side is resolved.
 */
function dedupeEdges(edges: CallEdge[], otherEnd: (e: CallEdge) => string): CallEdge[] {
  const byKey = new Map<string, CallEdge>();
  const order: string[] = [];
  for (const e of edges) {
    const key = `${otherEnd(e)}|${e.line}|${e.column ?? ""}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, e);
      order.push(key);
    } else if (!prev.resolved && e.resolved) {
      byKey.set(key, e); // prefer the resolved edge on a tie
    }
  }
  return order.map((k) => byKey.get(k)!);
}

/** Resolve a selector to a single symbol, or a QueryError describing the miss. */
function resolveOrError(graph: CallGraph, sel: SymbolSelector, projectRoot: string): SymbolRecord | QueryError {
  const r = resolveSymbol(graph, sel);
  if (r.status === "found") return r.symbol;
  if (r.status === "ambiguous") {
    return {
      error: `Ambiguous selector — ${r.candidates.length} symbols match. Re-call with a specific symbolId (or add kind/ownerClass).`,
      candidates: r.candidates.map((s) => summarize(s, projectRoot))
    };
  }
  return { error: "No symbol matched the given selector." };
}

export function searchSymbols(
  graph: CallGraph,
  projectRoot: string,
  args: { query: string; kind?: string; limit?: number }
): { count: number; results: SymbolSummary[] } {
  const limit = args.limit ?? 30;
  const kind = args.kind?.toLowerCase();
  const q = args.query.toLowerCase();

  // Rank: exact name, then prefix, then fuzzy subsequence.
  const scored: { s: SymbolRecord; rank: number }[] = [];
  for (const s of graph.allSymbols()) {
    if (kind && s.kind.toLowerCase() !== kind) continue;
    const name = s.name.toLowerCase();
    let rank: number;
    if (name === q) rank = 0;
    else if (name.startsWith(q)) rank = 1;
    else if (fuzzyMatch(args.query, s.name)) rank = 2;
    else continue;
    scored.push({ s, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.s.name.localeCompare(b.s.name));
  return {
    count: scored.length,
    results: scored.slice(0, limit).map((x) => summarize(x.s, projectRoot))
  };
}

export function getSymbol(graph: CallGraph, projectRoot: string, sel: SymbolSelector): QueryError | (SymbolSummary & {
  callerCount: number;
  calleeCount: number;
}) {
  const sym = resolveOrError(graph, sel, projectRoot);
  if (isQueryError(sym)) return sym;
  return {
    ...summarize(sym, projectRoot),
    callerCount: dedupeEdges(graph.callers(sym.id), (e) => e.fromId).length,
    calleeCount: dedupeEdges(graph.callees(sym.id), (e) => e.toId).length
  };
}

export function findCallers(
  graph: CallGraph,
  projectRoot: string,
  sel: SymbolSelector,
  limit = 100
): QueryError | {
  symbol: SymbolSummary;
  count: number;
  callers: ReturnType<typeof summarizeEdge>[];
  viaBase?: { base: SymbolSummary; sites: (ReturnType<typeof summarizeEdge> & { via: string })[] }[];
} {
  const sym = resolveOrError(graph, sel, projectRoot);
  if (isQueryError(sym)) return sym;
  const edges = dedupeEdges(graph.callers(sym.id), (e) => e.fromId);

  // Polymorphic dispatch: a call typed to an ancestor class resolves to that
  // ancestor's method, so an overriding method gets no *direct* caller edge.
  // `dispatchCallers` (in @4d/core, shared with the editor UI) returns those
  // base call sites, already deduped and with direct callers excluded; we tag
  // and format them here. The direct `count` stays exact.
  const viaBase: { base: SymbolSummary; sites: (ReturnType<typeof summarizeEdge> & { via: string })[] }[] = [];
  for (const { base, sites } of dispatchCallers(graph, sym.id)) {
    const via = `dispatched via base cs.${base.ownerClass}.${base.name}`;
    viaBase.push({
      base: summarize(base, projectRoot),
      sites: sites.slice(0, limit).map((e) => ({ ...summarizeEdge(e, e.fromId, graph, projectRoot), via }))
    });
  }

  return {
    symbol: summarize(sym, projectRoot),
    count: edges.length,
    callers: edges.slice(0, limit).map((e) => summarizeEdge(e, e.fromId, graph, projectRoot)),
    ...(viaBase.length ? { viaBase } : {})
  };
}

export function findCallees(
  graph: CallGraph,
  projectRoot: string,
  sel: SymbolSelector,
  limit = 100
): QueryError | { symbol: SymbolSummary; count: number; callees: ReturnType<typeof summarizeEdge>[] } {
  const sym = resolveOrError(graph, sel, projectRoot);
  if (isQueryError(sym)) return sym;
  const edges = dedupeEdges(graph.callees(sym.id), (e) => e.toId);
  return {
    symbol: summarize(sym, projectRoot),
    count: edges.length,
    callees: edges.slice(0, limit).map((e) => summarizeEdge(e, e.toId, graph, projectRoot))
  };
}

export function reachableQuery(
  graph: CallGraph,
  projectRoot: string,
  sel: SymbolSelector,
  depth: number,
  direction: "forward" | "reverse" | "both"
): QueryError | { symbol: SymbolSummary; depth: number; direction: string; count: number; nodes: SymbolSummary[] } {
  const sym = resolveOrError(graph, sel, projectRoot);
  if (isQueryError(sym)) return sym;
  const { nodes } = graph.reachable(sym.id, depth, direction);
  const summaries: SymbolSummary[] = [];
  for (const id of nodes) {
    if (id === sym.id) continue;
    const s = graph.symbol(id);
    if (s) summaries.push(summarize(s, projectRoot));
  }
  return { symbol: summarize(sym, projectRoot), depth, direction, count: summaries.length, nodes: summaries };
}

export function callPath(
  graph: CallGraph,
  projectRoot: string,
  fromSel: SymbolSelector,
  toSel: SymbolSelector,
  maxDepth: number,
  direction: "forward" | "reverse" | "both"
): QueryError | { from: SymbolSummary; to: SymbolSummary; found: boolean; hops: number; path: SymbolSummary[] } {
  const from = resolveOrError(graph, fromSel, projectRoot);
  if (isQueryError(from)) return from;
  const to = resolveOrError(graph, toSel, projectRoot);
  if (isQueryError(to)) return to;

  const edges = graph.shortestPath(from.id, to.id, maxDepth, direction);
  if (edges === null) {
    return { from: summarize(from, projectRoot), to: summarize(to, projectRoot), found: false, hops: 0, path: [] };
  }
  // Reconstruct the node sequence from the edge chain. For "reverse" the edges
  // point backwards (callee->caller), so the predecessor node flips.
  const path: SymbolSummary[] = [summarize(from, projectRoot)];
  let cur = from.id;
  for (const e of edges) {
    const nextId = e.fromId === cur ? e.toId : e.fromId;
    const s = graph.symbol(nextId);
    if (s) path.push(summarize(s, projectRoot));
    cur = nextId;
  }
  return { from: summarize(from, projectRoot), to: summarize(to, projectRoot), found: true, hops: edges.length, path };
}

export function classHierarchy(
  graph: CallGraph,
  projectRoot: string,
  className: string
): QueryError | {
  class: SymbolSummary;
  ancestors: SymbolSummary[];
  directSubclasses: SymbolSummary[];
  descendants: SymbolSummary[];
} {
  const cls = graph.byName(className).find((s) => s.kind === SymbolKind.Class);
  if (!cls) return { error: `No class named "${className}" found.` };

  // Walk up the extends chain (cycle-guarded), nearest ancestor first.
  const ancestors: SymbolSummary[] = [];
  const seen = new Set<string>([cls.name.toLowerCase()]);
  let parent = cls.extendsClass;
  while (parent && !seen.has(parent.toLowerCase())) {
    seen.add(parent.toLowerCase());
    const p = graph.byName(parent).find((s) => s.kind === SymbolKind.Class);
    if (!p) break;
    ancestors.push(summarize(p, projectRoot));
    parent = p.extendsClass;
  }

  return {
    class: summarize(cls, projectRoot),
    ancestors,
    directSubclasses: directSubclasses(graph, className).map((s) => summarize(s, projectRoot)),
    descendants: descendantClasses(graph, className).map((s) => summarize(s, projectRoot))
  };
}

/** A member row: a symbol summary plus call counts and (for own members that
 * shadow an ancestor function) the ancestor declaration it overrides. */
type MemberRow = SymbolSummary & {
  callerCount: number;
  calleeCount: number;
  overrides?: { id: string; ownerClass?: string };
};

export function classMembers(
  graph: CallGraph,
  projectRoot: string,
  className: string
): QueryError | {
  class: SymbolSummary;
  count: number;
  members: MemberRow[];
  inheritedCount: number;
  inherited: MemberRow[];
} {
  const cls = graph.byName(className).find((s) => s.kind === SymbolKind.Class);
  if (!cls) return { error: `No class named "${className}" found.` };

  const row = (s: SymbolRecord): MemberRow => ({
    ...summarize(s, projectRoot),
    callerCount: graph.callers(s.id).length,
    calleeCount: graph.callees(s.id).length
  });

  // Function-kind members inherited from ancestors (nearest declaration per
  // name). An own member whose name appears here overrides the mapped ancestor.
  const inherited = inheritedFunctions(graph, cls.name);

  const lower = className.toLowerCase();
  const ownNames = new Set<string>();
  const members: MemberRow[] = graph
    .allSymbols()
    .filter((s) => s.ownerClass?.toLowerCase() === lower)
    .sort((a, b) => a.location.line - b.location.line)
    .map((s) => {
      ownNames.add(s.name.toLowerCase());
      const base = inherited.get(s.name.toLowerCase());
      const r = row(s);
      if (base) r.overrides = { id: base.id, ownerClass: base.ownerClass };
      return r;
    });

  // Members visible on the class but declared in an ancestor and not shadowed
  // by an own member. Sorted by owning class then name for stable output.
  const inheritedRows: MemberRow[] = [...inherited.values()]
    .filter((s) => !ownNames.has(s.name.toLowerCase()))
    .sort((a, b) => (a.ownerClass ?? "").localeCompare(b.ownerClass ?? "") || a.name.localeCompare(b.name))
    .map(row);

  return {
    class: summarize(cls, projectRoot),
    count: members.length,
    members,
    inheritedCount: inheritedRows.length,
    inherited: inheritedRows
  };
}

/**
 * "Where is this class created or used?" — the answer find_callers can't give
 * directly, because `cs.<Class>.new()` edges land on the constructor symbol
 * (not the `Class`), and ORDA `ds.<DataClass>` / `cs.<Entity>` forms don't
 * edge to the `Class` at all.
 *
 * For any user class we gather direct `cs.<Class>.new()` callers — harvested
 * from both the `Class` symbol and its `ClassConstructor` symbol, since a
 * `cs.X.new()` edge targets whichever exists.
 *
 * For ORDA classes we additionally link a dataclass `Foo` to entity class
 * `FooEntity` / selection `FooSelection` (derived from the target class name),
 * then add callers of the synthetic `ds.<DataClass>.<method>` TableBuiltins
 * (new / query / get / all / …) — the dataclass CRUD sites that create or
 * return entities and selections.
 *
 * No graph mutation — this reads existing caller edges, so it needs no
 * INDEX_VERSION bump.
 */
export function findInstantiations(
  graph: CallGraph,
  projectRoot: string,
  className: string,
  limit = 100
): QueryError | {
  class: SymbolSummary;
  dataClass?: string;
  count: number;
  sites: (ReturnType<typeof summarizeEdge> & { via: string })[];
} {
  const cls = graph.byName(className).find((s) => s.kind === SymbolKind.Class);
  if (!cls) return { error: `No class named "${className}" found.` };

  // Derive the dataclass name this class belongs to.
  let dataClass: string | undefined;
  if (cls.classFlavor === ClassFlavor.DataClass || cls.classFlavor === ClassFlavor.DataStore) {
    dataClass = cls.name;
  } else if (/entity$/i.test(cls.name)) {
    dataClass = cls.name.replace(/entity$/i, "");
  } else if (/selection$/i.test(cls.name)) {
    dataClass = cls.name.replace(/selection$/i, "");
  }

  const seen = new Set<string>();
  const sites: (ReturnType<typeof summarizeEdge> & { via: string })[] = [];
  const add = (edge: CallEdge, via: string) => {
    const key = `${edge.fromId}|${edge.line}|${edge.column ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    sites.push({ ...summarizeEdge(edge, edge.fromId, graph, projectRoot), via });
  };

  // 1. Direct cs.<Class>.new() callers. A `cs.X.new()` edge lands on the
  // ClassConstructor symbol when X declares one, and on the Class symbol
  // otherwise — so harvest callers of both. This is what makes the tool work
  // for any user class, not just ORDA ones.
  for (const e of graph.callers(cls.id)) add(e, `cs.${cls.name}.new`);
  const ctor = graph.symbol(symbolIdFor(SymbolKind.ClassConstructor, "constructor", cls.name));
  if (ctor) {
    for (const e of graph.callers(ctor.id)) add(e, `cs.${cls.name}.new`);
  }

  // 2. ds.<DataClass>.<method> usage — callers of the per-dataclass TableBuiltins.
  if (dataClass) {
    const dcLower = dataClass.toLowerCase();
    for (const s of graph.allSymbols()) {
      if (s.kind !== SymbolKind.TableBuiltin || s.ownerTable?.toLowerCase() !== dcLower) continue;
      for (const e of graph.callers(s.id)) add(e, s.name);
    }
  }

  sites.sort((a, b) => a.symbol.name.localeCompare(b.symbol.name) || a.callLine - b.callLine);
  return {
    class: summarize(cls, projectRoot),
    dataClass,
    count: sites.length,
    sites: sites.slice(0, limit)
  };
}

export function findOverridesQuery(
  graph: CallGraph,
  projectRoot: string,
  sel: SymbolSelector
): QueryError | { function: SymbolSummary; count: number; overrides: SymbolSummary[] } {
  const sym = resolveOrError(graph, sel, projectRoot);
  if (isQueryError(sym)) return sym;
  const overrides = findOverridesOfFunction(graph, sym.id);
  return {
    function: summarize(sym, projectRoot),
    count: overrides.length,
    overrides: overrides.map((s) => summarize(s, projectRoot))
  };
}

export function findOverriddenQuery(
  graph: CallGraph,
  projectRoot: string,
  sel: SymbolSelector
): QueryError | { function: SymbolSummary; overridden: SymbolSummary | null } {
  const sym = resolveOrError(graph, sel, projectRoot);
  if (isQueryError(sym)) return sym;
  const base = findOverriddenFunction(graph, sym.id);
  return {
    function: summarize(sym, projectRoot),
    overridden: base ? summarize(base, projectRoot) : null
  };
}
