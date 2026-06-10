import { CallGraph, ClassFlavor, SymbolKind } from "@4d/core";
import type { CallEdge, SymbolRecord } from "@4d/core";

export interface CoverageReport {
  /** Symbols reachable forward from any test_* function */
  covered: Set<string>;
  /** Symbols not reached (excluding tests themselves, builtins, plugins) */
  uncovered: SymbolRecord[];
  /**
   * Map: target symbol id → set of test ids that *transitively* reach it (a test
   * "covers" it if running the test executes it through any call path).
   */
  reachedByTests: Map<string, Set<string>>;
  /**
   * Map: target symbol id → set of test ids that invoke it *directly* (the test
   * body calls `X.func()` itself). A subset of {@link reachedByTests}; this is
   * what the only-tests callers panel shows.
   */
  directTestCallers: Map<string, Set<string>>;
}

const NON_COVERAGE_KINDS = new Set<SymbolKind>([
  SymbolKind.Builtin,
  SymbolKind.Plugin,
  SymbolKind.CompilerMethod,
  SymbolKind.Unresolved
]);

/** Default detection patterns mirror the historical hardcoded conventions. */
export const DEFAULT_TEST_FUNCTION_PATTERN = /^test_/;
export const DEFAULT_TEST_CLASS_PATTERN = /_Test$/;

export interface CoverageOptions {
  /** A function whose name matches is a test seed (and is never "uncovered"). */
  testFunctionPattern?: RegExp;
  /** A function whose owning class name matches is excluded from "uncovered". */
  testClassPattern?: RegExp;
}

/**
 * Whether an edge represents the target actually being *invoked* — the only
 * kind of edge that should propagate test coverage. The call graph also carries
 * field read/write edges (tagged `access`); reading a plain field is not an
 * invocation and must not mark it (or anything reachable through it) as covered.
 *
 *  - no `access` tag      → a real call / instantiation        → invocation
 *  - `read`  on a getter  → the getter function runs           → invocation
 *  - `write` on a setter  → the setter function runs           → invocation
 *  - anything else (plain property / alias read or write)      → not invoked
 */
function isInvocationEdge(e: CallEdge, target: SymbolRecord | undefined): boolean {
  if (!target) return false;
  if (e.access === undefined) return true;
  if (e.access === "read" && target.kind === SymbolKind.ClassGetter) return true;
  if (e.access === "write" && target.kind === SymbolKind.ClassSetter) return true;
  return false;
}

/**
 * Forward closure that follows only invocation edges (see {@link isInvocationEdge}).
 * Unlike `CallGraph.forwardClosure` — which walks every edge and is used by the
 * caller/callee filter — this answers "what code does running `seed` actually
 * execute", which is what test coverage means.
 */
function callOnlyReached(graph: CallGraph, seed: string): Set<string> {
  const visited = new Set<string>([seed]);
  const stack: string[] = [seed];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of graph.callees(cur)) {
      if (visited.has(e.toId)) continue;
      if (!isInvocationEdge(e, graph.symbol(e.toId))) continue;
      visited.add(e.toId);
      stack.push(e.toId);
    }
  }
  return visited;
}

export function computeCoverage(graph: CallGraph, opts: CoverageOptions = {}): CoverageReport {
  const testFnRe = opts.testFunctionPattern ?? DEFAULT_TEST_FUNCTION_PATTERN;
  const testClassRe = opts.testClassPattern ?? DEFAULT_TEST_CLASS_PATTERN;
  const testSeeds: string[] = [];
  for (const s of graph.allSymbols()) {
    if (s.kind === SymbolKind.ClassFunction && testFnRe.test(s.name)) {
      testSeeds.push(s.id);
    }
  }
  const reachedByTests = new Map<string, Set<string>>();
  const directTestCallers = new Map<string, Set<string>>();
  const addTo = (map: Map<string, Set<string>>, id: string, seed: string) => {
    let bucket = map.get(id);
    if (!bucket) {
      bucket = new Set();
      map.set(id, bucket);
    }
    bucket.add(seed);
  };
  for (const seed of testSeeds) {
    // Transitive: everything the test executes through any call path.
    for (const id of callOnlyReached(graph, seed)) {
      if (id === seed) continue;
      addTo(reachedByTests, id, seed);
    }
    // Direct: only what the test body invokes itself (one hop, invocation edges).
    for (const e of graph.callees(seed)) {
      if (e.toId === seed) continue;
      if (!isInvocationEdge(e, graph.symbol(e.toId))) continue;
      addTo(directTestCallers, e.toId, seed);
    }
  }
  const covered = new Set<string>(reachedByTests.keys());
  const uncovered: SymbolRecord[] = [];
  for (const s of graph.allSymbols()) {
    if (NON_COVERAGE_KINDS.has(s.kind)) continue;
    if (s.classFlavor === ClassFlavor.Test) continue;
    if (testFnRe.test(s.name)) continue;
    if (s.ownerClass && testClassRe.test(s.ownerClass)) continue;
    if (s.kind !== SymbolKind.ProjectMethod && s.kind !== SymbolKind.ClassFunction) continue;
    if (!covered.has(s.id)) uncovered.push(s);
  }
  return { covered, uncovered, reachedByTests, directTestCallers };
}
