import { CallGraph, SymbolRecord } from "@4d/core";

/**
 * How a tool selects a symbol: by stable `symbolId`, or by `name` with
 * optional `kind` / `ownerClass` filters to disambiguate. Names are matched
 * case-insensitively (the graph indexes lowercased names).
 */
export interface SymbolSelector {
  symbolId?: string;
  name?: string;
  kind?: string;
  ownerClass?: string;
}

export type ResolveResult =
  | { status: "found"; symbol: SymbolRecord }
  | { status: "ambiguous"; candidates: SymbolRecord[] }
  | { status: "notFound" };

export function resolveSymbol(graph: CallGraph, sel: SymbolSelector): ResolveResult {
  if (sel.symbolId) {
    const s = graph.symbol(sel.symbolId);
    return s ? { status: "found", symbol: s } : { status: "notFound" };
  }
  if (!sel.name) return { status: "notFound" };

  let candidates = graph.byName(sel.name);
  if (sel.kind) {
    const k = sel.kind.toLowerCase();
    candidates = candidates.filter((s) => s.kind.toLowerCase() === k);
  }
  if (sel.ownerClass) {
    const oc = sel.ownerClass.toLowerCase();
    candidates = candidates.filter((s) => s.ownerClass?.toLowerCase() === oc);
  }

  if (candidates.length === 0) return { status: "notFound" };
  if (candidates.length === 1) return { status: "found", symbol: candidates[0] };
  return { status: "ambiguous", candidates };
}
