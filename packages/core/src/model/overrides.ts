import { CallGraph } from "./callGraph";
import { SymbolKind } from "./symbol";
import type { SymbolRecord } from "./symbol";

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
