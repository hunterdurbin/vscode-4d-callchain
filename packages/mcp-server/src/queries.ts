import {
  CallGraph,
  SymbolKind,
  SymbolRecord,
  descendantClasses,
  directSubclasses,
  findOverriddenFunction,
  findOverridesOfFunction,
  fuzzyMatch
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
    callerCount: graph.callers(sym.id).length,
    calleeCount: graph.callees(sym.id).length
  };
}

export function findCallers(
  graph: CallGraph,
  projectRoot: string,
  sel: SymbolSelector,
  limit = 100
): QueryError | { symbol: SymbolSummary; count: number; callers: ReturnType<typeof summarizeEdge>[] } {
  const sym = resolveOrError(graph, sel, projectRoot);
  if (isQueryError(sym)) return sym;
  const edges = graph.callers(sym.id);
  return {
    symbol: summarize(sym, projectRoot),
    count: edges.length,
    callers: edges.slice(0, limit).map((e) => summarizeEdge(e, e.fromId, graph, projectRoot))
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
  const edges = graph.callees(sym.id);
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
