import { CallGraph } from "../model/callGraph";
import { ClassFlavor, SymbolKind, SymbolRecord } from "../model/symbol";

export interface CoverageReport {
  /** Symbols reachable forward from any test_* function */
  covered: Set<string>;
  /** Symbols not reached (excluding tests themselves, builtins, plugins) */
  uncovered: SymbolRecord[];
  /** Map: target symbol id → set of test function ids that reach it */
  reachedByTests: Map<string, Set<string>>;
}

const NON_COVERAGE_KINDS = new Set<SymbolKind>([
  SymbolKind.Builtin,
  SymbolKind.Plugin,
  SymbolKind.CompilerMethod,
  SymbolKind.Unresolved
]);

export function computeCoverage(graph: CallGraph): CoverageReport {
  const testSeeds: string[] = [];
  for (const s of graph.allSymbols()) {
    if (s.kind === SymbolKind.ClassFunction && s.name.startsWith("test_")) {
      testSeeds.push(s.id);
    }
  }
  const reachedByTests = new Map<string, Set<string>>();
  for (const seed of testSeeds) {
    const reached = graph.forwardClosure([seed]);
    for (const id of reached) {
      if (id === seed) continue;
      let bucket = reachedByTests.get(id);
      if (!bucket) {
        bucket = new Set();
        reachedByTests.set(id, bucket);
      }
      bucket.add(seed);
    }
  }
  const covered = new Set<string>(reachedByTests.keys());
  const uncovered: SymbolRecord[] = [];
  for (const s of graph.allSymbols()) {
    if (NON_COVERAGE_KINDS.has(s.kind)) continue;
    if (s.classFlavor === ClassFlavor.Test) continue;
    if (s.name.startsWith("test_")) continue;
    if (s.kind !== SymbolKind.ProjectMethod && s.kind !== SymbolKind.ClassFunction) continue;
    if (!covered.has(s.id)) uncovered.push(s);
  }
  return { covered, uncovered, reachedByTests };
}
