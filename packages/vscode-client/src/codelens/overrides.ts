import { CallGraph, SymbolKind } from "@4d/core";
import type { SymbolRecord } from "@4d/core";

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
