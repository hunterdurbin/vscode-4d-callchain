import { CallGraph } from "./callGraph";
import { SymbolKind } from "./symbol";
import type { CallEdge, SymbolRecord } from "./symbol";

/**
 * Class-member kinds declared with the `Function` keyword in 4D source —
 * plain `Function`, `Function get`, and `Function set`. The `Class constructor`
 * is intentionally excluded: only these participate in override detection.
 */
export const FUNCTION_KINDS: ReadonlySet<SymbolKind> = new Set([
  SymbolKind.ClassFunction,
  SymbolKind.ClassGetter,
  SymbolKind.ClassSetter
]);

/**
 * All classes that (transitively) extend `className`, as lowercased names.
 * Inheritance is only tracked upward (`extendsClass`), so we build a
 * direct-subclass adjacency in one pass over the graph and BFS downward.
 * Excludes `className` itself; cycle-guarded.
 */
export function descendantClassNames(graph: CallGraph, className: string): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const s of graph.allSymbols()) {
    if (s.kind !== SymbolKind.Class || !s.extendsClass) continue;
    const parent = s.extendsClass.toLowerCase();
    const list = childrenByParent.get(parent) ?? [];
    list.push(s.name.toLowerCase());
    childrenByParent.set(parent, list);
  }

  const out = new Set<string>();
  const stack = [className.toLowerCase()];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const child of childrenByParent.get(cur) ?? []) {
      if (out.has(child)) continue; // cycle / diamond guard
      out.add(child);
      stack.push(child);
    }
  }
  return out;
}

/**
 * Classes that directly extend `className` (their `Class extends` names it).
 */
export function directSubclasses(graph: CallGraph, className: string): SymbolRecord[] {
  const target = className.toLowerCase();
  return graph
    .allSymbols()
    .filter((s) => s.kind === SymbolKind.Class && s.extendsClass?.toLowerCase() === target);
}

/**
 * Every class (transitively) below `className`, as `Class` records sorted by
 * name. Used by the "Extended by N" lens command so the user can jump to any
 * descendant, not just direct children.
 */
export function descendantClasses(graph: CallGraph, className: string): SymbolRecord[] {
  const names = descendantClassNames(graph, className);
  if (names.size === 0) return [];
  const out: SymbolRecord[] = [];
  for (const s of graph.allSymbols()) {
    if (s.kind === SymbolKind.Class && names.has(s.name.toLowerCase())) out.push(s);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Maps each base-class function name (lowercased) to the function-kind members
 * in descendant classes that override it. One pass over the graph; the result
 * is keyed so the lens provider can do O(1) lookups per function in a document.
 * Overrides are sorted by owning class name for stable quick-pick order.
 */
export function overridesForClass(graph: CallGraph, className: string): Map<string, SymbolRecord[]> {
  const descendants = descendantClassNames(graph, className);
  const byName = new Map<string, SymbolRecord[]>();
  if (descendants.size === 0) return byName;

  for (const s of graph.allSymbols()) {
    if (!FUNCTION_KINDS.has(s.kind)) continue;
    if (!s.ownerClass || !descendants.has(s.ownerClass.toLowerCase())) continue;
    const key = s.name.toLowerCase();
    const list = byName.get(key) ?? [];
    list.push(s);
    byName.set(key, list);
  }

  for (const list of byName.values()) {
    list.sort((a, b) => (a.ownerClass ?? "").localeCompare(b.ownerClass ?? ""));
  }
  return byName;
}

/**
 * Overrides of a single base function, identified by its symbol id. Convenience
 * wrapper used by the `callchain.showOverrides` command.
 */
export function findOverridesOfFunction(graph: CallGraph, baseSymbolId: string): SymbolRecord[] {
  const base = graph.symbol(baseSymbolId);
  if (!base || !base.ownerClass || !FUNCTION_KINDS.has(base.kind)) return [];
  return overridesForClass(graph, base.ownerClass).get(base.name.toLowerCase()) ?? [];
}

/** The `extendsClass` of a class, looked up by class name. */
function parentClassName(graph: CallGraph, className: string): string | undefined {
  return graph.byName(className).find((s) => s.kind === SymbolKind.Class)?.extendsClass;
}

/**
 * Which member slot a reference targets, mirroring the resolver's ThisCall /
 * ThisGet / ThisSet lookup order: `call` for `This.fn()`, `read`/`write` for
 * property access (from `CallEdge.access`).
 */
export type MemberSlot = "call" | "read" | "write";

/**
 * Kind passes per slot, in the resolver's priority order: a getter anywhere on
 * the chain beats an alias anywhere, which beats a plain property — each pass
 * walks the full chain before the next kind is tried (matches
 * resolveGetterOnChain → resolveAliasOnChain → resolvePropertyOnChain).
 */
const SLOT_KIND_PASSES: Record<MemberSlot, SymbolKind[]> = {
  call: [SymbolKind.ClassFunction],
  read: [SymbolKind.ClassGetter, SymbolKind.Alias, SymbolKind.ClassProperty],
  write: [SymbolKind.ClassSetter, SymbolKind.Alias, SymbolKind.ClassProperty]
};

/**
 * Resolve `memberName` for a CONCRETE receiver class: the declaration that
 * actually runs when an instance of `className` references the member. Walks
 * the `extendsClass` chain upward from `className` itself (nearest declaration
 * wins), cycle-guarded, case-insensitive. Used by the Method Trace to
 * re-resolve `This.x` references against the pinned receiver class
 * (polymorphic dispatch). Returns undefined when no declaration exists
 * anywhere on the chain (e.g. an abstract hook).
 */
export function resolveMemberForClass(
  graph: CallGraph,
  className: string,
  memberName: string,
  slot: MemberSlot
): SymbolRecord | undefined {
  const candidates = graph.byName(memberName);
  if (candidates.length === 0) return undefined;
  for (const kind of SLOT_KIND_PASSES[slot]) {
    const visited = new Set<string>();
    let cur: string | undefined = className;
    while (cur && !visited.has(cur.toLowerCase())) {
      const curLower = cur.toLowerCase();
      visited.add(curLower);
      const hit = candidates.find((s) => s.kind === kind && s.ownerClass?.toLowerCase() === curLower);
      if (hit) return hit;
      cur = parentClassName(graph, cur);
    }
  }
  return undefined;
}

/** The single override-relevant kind per slot (used to filter candidates). */
const SLOT_OVERRIDE_KIND: Record<MemberSlot, SymbolKind> = {
  call: SymbolKind.ClassFunction,
  read: SymbolKind.ClassGetter,
  write: SymbolKind.ClassSetter
};

/**
 * Descendant overrides of (`className`, `memberName`) compatible with `slot` —
 * the "may run" dispatch targets when the concrete receiver class is unknown.
 * Built on `overridesForClass`, so it works even when the base member has no
 * symbol at all (a purely abstract hook only referenced via `This.x`). Pass a
 * `precomputed` map (one `overridesForClass` result) to amortize the
 * O(symbols) scan across many lookups for the same class.
 */
export function overrideCandidates(
  graph: CallGraph,
  className: string,
  memberName: string,
  slot: MemberSlot,
  precomputed?: Map<string, SymbolRecord[]>
): SymbolRecord[] {
  const byName = precomputed ?? overridesForClass(graph, className);
  const list = byName.get(memberName.toLowerCase()) ?? [];
  const kind = SLOT_OVERRIDE_KIND[slot];
  return list.filter((s) => s.kind === kind);
}

/**
 * Function-kind members inherited from the strict ancestors of `className`,
 * keyed by lowercased member name → the nearest ancestor's declaration. Walks
 * up the `extendsClass` chain (cycle-guarded), keeping the first (nearest)
 * declaration of each name. This is the upward mirror of `overridesForClass`:
 * a member in `className` whose name is in this map overrides the mapped one.
 */
export function inheritedFunctions(graph: CallGraph, className: string): Map<string, SymbolRecord> {
  const out = new Map<string, SymbolRecord>();
  const visited = new Set<string>([className.toLowerCase()]);
  let cur = parentClassName(graph, className);
  while (cur && !visited.has(cur.toLowerCase())) {
    visited.add(cur.toLowerCase());
    const curLower = cur.toLowerCase();
    for (const s of graph.allSymbols()) {
      if (!FUNCTION_KINDS.has(s.kind)) continue;
      if (s.ownerClass?.toLowerCase() !== curLower) continue;
      const key = s.name.toLowerCase();
      if (!out.has(key)) out.set(key, s); // nearest ancestor wins
    }
    cur = parentClassName(graph, cur);
  }
  return out;
}

/**
 * The ancestor function that `baseSymbolId` overrides, if any. Convenience
 * wrapper used by the `callchain.showOverridden` command.
 */
export function findOverriddenFunction(graph: CallGraph, baseSymbolId: string): SymbolRecord | undefined {
  const base = graph.symbol(baseSymbolId);
  if (!base || !base.ownerClass || !FUNCTION_KINDS.has(base.kind)) return undefined;
  return inheritedFunctions(graph, base.ownerClass).get(base.name.toLowerCase());
}

/**
 * Every strict-ancestor declaration of the same-named function that
 * `baseSymbolId` overrides, nearest-first. Unlike `findOverriddenFunction`
 * (nearest only), this returns *all* ancestors that declare the member — a
 * polymorphic call typed to any ancestor can dispatch to this override, so
 * each ancestor's call sites are potential virtual callers. Walks the
 * `extendsClass` chain, cycle-guarded; returns `[]` for non-function symbols
 * or symbols that override nothing.
 */
export function overriddenFunctionChain(graph: CallGraph, baseSymbolId: string): SymbolRecord[] {
  const base = graph.symbol(baseSymbolId);
  if (!base || !base.ownerClass || !FUNCTION_KINDS.has(base.kind)) return [];
  const name = base.name.toLowerCase();
  const out: SymbolRecord[] = [];
  const visited = new Set<string>([base.ownerClass.toLowerCase()]);
  let cur = parentClassName(graph, base.ownerClass);
  while (cur && !visited.has(cur.toLowerCase())) {
    visited.add(cur.toLowerCase());
    const curLower = cur.toLowerCase();
    for (const s of graph.allSymbols()) {
      if (!FUNCTION_KINDS.has(s.kind)) continue;
      if (s.ownerClass?.toLowerCase() !== curLower) continue;
      if (s.name.toLowerCase() === name) out.push(s);
    }
    cur = parentClassName(graph, cur);
  }
  return out;
}

/** A base method whose call sites can dispatch (polymorphically) to an override. */
export interface DispatchCallerGroup {
  base: SymbolRecord;
  sites: CallEdge[];
}

/** Stable per-call-site key (caller + line + column). */
function callSiteKey(e: CallEdge): string {
  return `${e.fromId}|${e.line}|${e.column ?? ""}`;
}

/**
 * Collapse duplicate edges that share a call site (same caller/line/column),
 * preferring the resolved one — mirrors the MCP query layer's dedupe so counts
 * match across UI and tools.
 */
function dedupeBySite(edges: CallEdge[]): CallEdge[] {
  const byKey = new Map<string, CallEdge>();
  const order: string[] = [];
  for (const e of edges) {
    const key = callSiteKey(e);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, e);
      order.push(key);
    } else if (!prev.resolved && e.resolved) {
      byKey.set(key, e);
    }
  }
  return order.map((k) => byKey.get(k)!);
}

/**
 * Polymorphic-dispatch callers of an overriding function: call sites that
 * resolve to an ancestor's same-named method (the call is typed to the base)
 * but can dispatch to `symbolId` at runtime. Because no edge points at the
 * override itself, these are invisible to a plain `graph.callers()` — so an
 * override looks like dead code without them.
 *
 * Walks every ancestor declaration (`overriddenFunctionChain`), gathers that
 * ancestor's caller edges (deduped per call site), and excludes any that are
 * already a *direct* caller of `symbolId`. Returns one group per ancestor that
 * has surviving sites; `[]` when the symbol overrides nothing or no base has
 * callers. Read-only — no graph mutation, no INDEX_VERSION impact.
 */
export function dispatchCallers(graph: CallGraph, symbolId: string): DispatchCallerGroup[] {
  const chain = overriddenFunctionChain(graph, symbolId);
  if (chain.length === 0) return [];
  const directKeys = new Set(graph.callers(symbolId).map(callSiteKey));
  const out: DispatchCallerGroup[] = [];
  for (const base of chain) {
    const sites = dedupeBySite(graph.callers(base.id)).filter((e) => !directKeys.has(callSiteKey(e)));
    if (sites.length) out.push({ base, sites });
  }
  return out;
}
