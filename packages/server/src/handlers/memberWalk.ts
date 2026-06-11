import { CallGraph, SymbolKind, SymbolRecord } from "@4d/core";

/** Kinds that surface under a class on member completion / signature help. */
export const CLASS_MEMBER_KINDS = new Set<SymbolKind>([
  SymbolKind.ClassFunction,
  SymbolKind.ClassConstructor,
  SymbolKind.ClassGetter,
  SymbolKind.ClassSetter
]);

/** Walk the inheritance chain; collect class members of the matched kinds. */
export function membersOfClass(graph: CallGraph, className: string): SymbolRecord[] {
  const out: SymbolRecord[] = [];
  const seenNames = new Set<string>();
  const visited = new Set<string>();
  let cur: string | undefined = className;
  while (cur && !visited.has(cur.toLowerCase())) {
    visited.add(cur.toLowerCase());
    for (const s of graph.allSymbols()) {
      if (!s.ownerClass) continue;
      if (s.ownerClass.toLowerCase() !== cur.toLowerCase()) continue;
      if (!CLASS_MEMBER_KINDS.has(s.kind)) continue;
      if (seenNames.has(s.name.toLowerCase())) continue;
      seenNames.add(s.name.toLowerCase());
      out.push(s);
    }
    const parent: string | undefined = graph
      .byName(cur)
      .find((s) => s.kind === SymbolKind.Class)?.extendsClass;
    cur = parent;
  }
  return out;
}

/** Component classes under a given classStore namespace (e.g. `Testing`). */
export function componentClassesInNs(graph: CallGraph, namespace: string): SymbolRecord[] {
  const prefix = `Class:cs.${namespace}.`.toLowerCase();
  return graph
    .allSymbols()
    .filter((s) => s.kind === SymbolKind.Class && s.id.toLowerCase().startsWith(prefix));
}

/**
 * Look up `<ownerClass>.<name>` member directly (no inheritance walk). Used
 * when the caller already has a fully-qualified class id (e.g. component
 * namespace).
 */
export function memberByOwner(
  graph: CallGraph,
  ownerClass: string,
  memberName: string
): SymbolRecord | undefined {
  const ownerLc = ownerClass.toLowerCase();
  const memberLc = memberName.toLowerCase();
  return graph
    .allSymbols()
    .find(
      (s) =>
        s.ownerClass?.toLowerCase() === ownerLc &&
        s.name.toLowerCase() === memberLc &&
        CLASS_MEMBER_KINDS.has(s.kind)
    );
}
