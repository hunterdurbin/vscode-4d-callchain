import * as vscode from "vscode";
import { CallGraph, ClassFlavor, SymbolKind } from "@4d/core";
import type { SymbolRecord } from "@4d/core";
import { TestStatusDecorator } from "../decorations/testStatusDecorator";
import { CoverageReport, DEFAULT_TEST_PATTERNS, isTestSymbol, type TestPatterns } from "../testing/coverage";
import { FUNCTION_KINDS, descendantClassNames, directSubclasses, dispatchCallers, inheritedFunctions, overridesForClass } from "./overrides";

/**
 * Field-like members that carry read/write usage edges (vs. plain call edges):
 * plain `property` fields, computed-attribute getters/setters, and ORDA aliases.
 * These render a `↔ N reads · M writes` usage lens instead of `▲ N callers`.
 */
const FIELD_LIKE_KINDS = new Set<SymbolKind>([
  SymbolKind.ClassProperty,
  SymbolKind.ClassGetter,
  SymbolKind.ClassSetter,
  SymbolKind.Alias
]);

/**
 * Symbols that can carry a "tests cover this" lens — things that are actually
 * invoked. Plain fields (ClassProperty / Alias) are excluded: coverage means a
 * function runs, and reading a field is not an invocation.
 */
const COVERAGE_LENS_KINDS = new Set<SymbolKind>([
  SymbolKind.ProjectMethod,
  SymbolKind.ClassFunction,
  SymbolKind.ClassConstructor,
  SymbolKind.ClassGetter,
  SymbolKind.ClassSetter
]);

/**
 * Build the usage-lens title. `compact` (used when multiple field-like members
 * share one line) shortens "reads/writes" to "r/w" and prefixes the member name
 * so each stacked lens stays identifiable.
 */
function usageLensTitle(reads: number, writes: number, compact: boolean, name?: string): string {
  const r = compact ? `${reads}r` : `${reads} read${reads === 1 ? "" : "s"}`;
  const w = compact ? `${writes}w` : `${writes} write${writes === 1 ? "" : "s"}`;
  let body: string;
  if (reads > 0 && writes > 0) body = `${r} · ${w}`;
  else if (writes > 0) body = w;
  else if (reads > 0) body = r;
  else body = "no usages";
  return `${name ? `${name}: ` : ""}↔ ${body}`;
}

/** The per-lens visibility toggles, read once and cached (see below). */
interface LensConfig {
  showCallers: boolean;
  showCallees: boolean;
  showViaBase: boolean;
  showTrace: boolean;
  showOverrides: boolean;
  showOverriding: boolean;
  showExtendedBy: boolean;
  showPropertyUsage: boolean;
}

function readLensConfig(): LensConfig {
  const cfg = vscode.workspace.getConfiguration("callchain");
  return {
    showCallers: cfg.get<boolean>("codeLens.showCallers", true),
    showCallees: cfg.get<boolean>("codeLens.showCallees", false),
    showViaBase: cfg.get<boolean>("codeLens.showViaBase", true),
    showTrace: cfg.get<boolean>("codeLens.showTrace", false),
    showOverrides: cfg.get<boolean>("codeLens.showOverrides", true),
    showOverriding: cfg.get<boolean>("codeLens.showOverriding", true),
    showExtendedBy: cfg.get<boolean>("codeLens.showExtendedBy", true),
    showPropertyUsage: cfg.get<boolean>("codeLens.showPropertyUsage", true)
  };
}

export class CallChainLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  // provideCodeLenses runs on every document change/save; eight
  // getConfiguration round-trips per call are pure overhead, so the toggles
  // are cached and refreshed by the config listener below.
  private config = readLensConfig();
  private readonly configListener: vscode.Disposable;

  constructor(
    private graphGetter: () => CallGraph | undefined,
    private testStatusGetter: () => TestStatusDecorator | undefined,
    private coverageGetter: () => CoverageReport | undefined,
    private testPatternsGetter: () => TestPatterns = () => DEFAULT_TEST_PATTERNS,
    private lineMap?: (uri: string, savedLine: number) => number
  ) {
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("callchain.codeLens")) {
        this.config = readLensConfig();
        this.refresh();
      }
    });
  }

  dispose(): void {
    this.configListener.dispose();
    this.emitter.dispose();
  }

  refresh(): void {
    this.emitter.fire();
  }

  /**
   * Map a symbol's saved (last-parsed) line to the line it should render on
   * right now. While a document is dirty the dirty-line tracker shifts lenses
   * by the net newlines added/removed above them; with no tracker this is the
   * identity.
   */
  private mapLine(uri: string, savedLine: number): number {
    return this.lineMap ? this.lineMap(uri, savedLine) : savedLine;
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!doc.uri.path.endsWith(".4dm") && !doc.uri.path.endsWith(".4DForm")) return [];
    const graph = this.graphGetter();
    if (!graph) return [];

    const docUri = doc.uri.toString();
    // By-URI lookup maintained by the graph — previously a full
    // allSymbols() scan with a per-symbol decode on every lens request.
    const symbols = graph.symbolsInFile(docUri);
    if (symbols.length === 0) return [];

    const decorator = this.testStatusGetter();
    const coverage = this.coverageGetter();
    const testPatterns = this.testPatternsGetter();

    const {
      showCallers, showCallees, showViaBase, showTrace,
      showOverrides, showOverriding, showExtendedBy, showPropertyUsage
    } = this.config;

    // Count field-like members per (mapped) line so we can disambiguate stacked
    // lenses when several share a line (`property text1; text2 : Text`).
    const fieldLikePerLine = new Map<number, number>();
    if (showPropertyUsage) {
      for (const s of symbols) {
        if (!FIELD_LIKE_KINDS.has(s.kind)) continue;
        const ln = this.mapLine(docUri, s.location.line);
        fieldLikePerLine.set(ln, (fieldLikePerLine.get(ln) ?? 0) + 1);
      }
    }

    // Override maps are keyed per declaring class. A 4D class file is one class,
    // so we build each map at most once per document and reuse it across
    // functions. overrideMap = members overridden BELOW (by subclasses);
    // inheritedMap = members this class overrides ABOVE (from ancestors).
    let overrideMap: Map<string, SymbolRecord[]> | undefined;
    let inheritedMap: Map<string, SymbolRecord> | undefined;
    if (showOverrides || showOverriding || showViaBase) {
      const classSym = symbols.find((s) => s.kind === SymbolKind.Class);
      if (classSym) {
        if (showOverrides) overrideMap = overridesForClass(graph, classSym.name);
        // inheritedMap (functions this class overrides above) is also the cheap
        // gate for the via-base lens — only an override can have dispatch callers.
        if ((showOverriding || showViaBase) && classSym.extendsClass) {
          inheritedMap = inheritedFunctions(graph, classSym.name);
        }
      }
    }

    // A 4D class file is one class. When it declares no `Class constructor`,
    // `cs.X.new()` instantiation edges land on the Class symbol itself (the
    // resolver falls back to it), so surface the caller count at the top of the
    // class instead of on a constructor line that doesn't exist.
    const hasConstructor = symbols.some((s) => s.kind === SymbolKind.ClassConstructor);

    const out: vscode.CodeLens[] = [];
    for (const s of symbols) {
      if (s.kind === SymbolKind.Class) {
        out.push(...this.lensesForClass(s, docUri, showExtendedBy, graph, showCallers && !hasConstructor, decorator !== undefined));
        continue;
      }
      const callerCount = graph.callers(s.id).length;
      const calleeCount = graph.callees(s.id).length;
      const line = this.mapLine(docUri, s.location.line);
      const range = new vscode.Range(line, 0, line, 1);

      // Field-like members (property / getter / setter / alias) show their
      // read/write usage split instead of a plain caller count. Clicking still
      // pins + reveals the caller tree (reads and writes both appear there).
      if (showPropertyUsage && FIELD_LIKE_KINDS.has(s.kind)) {
        const reads = graph.reads(s.id).length;
        const writes = graph.writes(s.id).length;
        const shared = (fieldLikePerLine.get(line) ?? 0) > 1;
        out.push(new vscode.CodeLens(range, {
          title: usageLensTitle(reads, writes, shared, shared ? s.name : undefined),
          command: "callchain.pinAndReveal",
          arguments: [s.id, "callers"]
        }));
      } else if (showCallers) out.push(new vscode.CodeLens(range, {
        title: `▲ ${callerCount} callers`,
        command: "callchain.pinAndReveal",
        arguments: [s.id, "callers"]
      }));
      if (showCallees) out.push(new vscode.CodeLens(range, {
        title: `▼ ${calleeCount} callees`,
        command: "callchain.pinAndReveal",
        arguments: [s.id, "callees"]
      }));
      if (showTrace) out.push(new vscode.CodeLens(range, {
        title: `⇲ Trace`,
        command: "callchain.showTrace",
        arguments: [s.id]
      }));

      // Overrides: only on `Function` declarations (plain / get / set). The two
      // directions can both appear on a mid-chain function.
      if (FUNCTION_KINDS.has(s.kind)) {
        const overridesParent = inheritedMap?.get(s.name.toLowerCase());
        // ⊕ polymorphic-dispatch callers: this override is reached through a
        // base-typed call that `▲ N callers` (direct edges only) can't see.
        if (showViaBase && overridesParent) {
          const viaCount = dispatchCallers(graph, s.id).reduce((n, g) => n + g.sites.length, 0);
          if (viaCount > 0) {
            out.push(new vscode.CodeLens(range, {
              title: `⊕ ${viaCount} via base`,
              command: "callchain.pinAndReveal",
              arguments: [s.id, "callers"]
            }));
          }
        }
        // ↥ this function overrides an ancestor's function
        if (showOverriding && overridesParent) {
          out.push(new vscode.CodeLens(range, {
            title: `↥ overrides ${overridesParent.ownerClass}`,
            command: "callchain.showOverridden",
            arguments: [s.id, line]
          }));
        }
        // ↧ this function is overridden by descendant classes
        if (overrideMap) {
          const overrides = overrideMap.get(s.name.toLowerCase());
          if (overrides && overrides.length > 0) {
            const n = overrides.length;
            out.push(new vscode.CodeLens(range, {
              title: `↧ ${n} override${n === 1 ? "" : "s"}`,
              command: "callchain.showOverrides",
              arguments: [s.id, line]
            }));
          }
        }
      }

      // Tests covering this (only for non-test, actually-invokable symbols —
      // never plain properties/aliases, which are read, not called).
      const isTest = isTestSymbol(s, testPatterns);
      if (!isTest && coverage && COVERAGE_LENS_KINDS.has(s.kind)) {
        const transitive = coverage.reachedByTests.get(s.id)?.size ?? 0;
        if (transitive > 0) {
          // Lens shows DIRECT test callers (matches the only-tests callers panel
          // the lens opens); the hover adds the transitive "executed by" count.
          const direct = coverage.directTestCallers.get(s.id)?.size ?? 0;
          out.push(new vscode.CodeLens(range, {
            title: `ⓘ ${direct} test${direct === 1 ? "" : "s"} call this directly`,
            tooltip: `${direct} call${direct === 1 ? "s" : ""} directly · ${transitive} execute${transitive === 1 ? "s" : ""} it transitively`,
            command: "callchain.showTestCallers",
            arguments: [s.id]
          }));
        } else if (s.kind === SymbolKind.ClassFunction || s.kind === SymbolKind.ProjectMethod) {
          out.push(new vscode.CodeLens(range, {
            title: `⚠ no tests cover this`,
            command: "callchain.jumpToTests",
            arguments: [s.id]
          }));
        }
      }

      // Test result + run button on test functions. Keyed on the test-function
      // pattern + a test-flavored class: these run via the 4D test runner, which
      // needs an owning class (standalone test methods can't be run this way).
      // The decorator only exists when test integration is enabled — without
      // it there is no run command either, so the lens is suppressed.
      if (decorator && s.classFlavor === ClassFlavor.Test && testPatterns.testFunctionPattern.test(s.name) && s.ownerClass) {
        const r = decorator.resultFor(s.ownerClass, s.name);
        const status = r ? (r.status === "passed" ? "✓" : "✗") : "○";
        out.push(new vscode.CodeLens(range, {
          title: `${status} Run`,
          command: "callchain.runTestsForClass",
          arguments: [s.ownerClass]
        }));
      }
    }
    return out;
  }

  private lensesForClass(
    s: SymbolRecord,
    docUri: string,
    showExtendedBy: boolean,
    graph: CallGraph,
    showClassCallers: boolean,
    testRunAvailable: boolean
  ): vscode.CodeLens[] {
    const line = this.mapLine(docUri, s.location.line);
    const range = new vscode.Range(line, 0, line, 1);
    const lenses: vscode.CodeLens[] = [];
    // Constructor-less class: its instantiation (`cs.X.new()`) callers attach to
    // the Class symbol. Show them first so the count sits at the top of the class.
    if (showClassCallers) {
      const callerCount = graph.callers(s.id).length;
      lenses.push(new vscode.CodeLens(range, {
        title: `▲ ${callerCount} callers`,
        command: "callchain.pinAndReveal",
        arguments: [s.id, "callers"]
      }));
    }
    if (showExtendedBy) {
      const direct = directSubclasses(graph, s.name).length;
      if (direct > 0) {
        const total = descendantClassNames(graph, s.name).size;
        const title =
          total > direct
            ? `↥ Extended by ${direct} (${total} total)`
            : `↥ Extended by ${direct} other${direct === 1 ? "" : "s"}`;
        lenses.push(new vscode.CodeLens(range, {
          title,
          command: "callchain.showSubclasses",
          arguments: [s.id, line]
        }));
      }
    }
    if (testRunAvailable && s.classFlavor === ClassFlavor.Test) {
      lenses.push(new vscode.CodeLens(range, {
        title: `▶ Run tests for ${s.name}`,
        command: "callchain.runTestsForClass",
        arguments: [s.name]
      }));
    }
    return lenses;
  }
}

