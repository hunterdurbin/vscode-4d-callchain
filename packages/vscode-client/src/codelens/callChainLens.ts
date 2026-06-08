import * as vscode from "vscode";
import { CallGraph, ClassFlavor, SymbolKind } from "@4d/core";
import type { SymbolRecord } from "@4d/core";
import { TestStatusDecorator } from "../decorations/testStatusDecorator";
import { CoverageReport } from "../testing/coverage";
import { FUNCTION_KINDS, descendantClassNames, directSubclasses, overridesForClass } from "./overrides";

export class CallChainLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(
    private graphGetter: () => CallGraph | undefined,
    private testStatusGetter: () => TestStatusDecorator,
    private coverageGetter: () => CoverageReport | undefined,
    private lineMap?: (uri: string, savedLine: number) => number
  ) {}

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
    const symbols = graph.allSymbols().filter((s) => sameUri(s.location.uri, docUri));
    if (symbols.length === 0) return [];

    const decorator = this.testStatusGetter();
    const coverage = this.coverageGetter();

    const cfg = vscode.workspace.getConfiguration("callchain");
    const showCallers = cfg.get<boolean>("codeLens.showCallers", true);
    const showCallees = cfg.get<boolean>("codeLens.showCallees", false);
    const showGraph = cfg.get<boolean>("codeLens.showGraph", false);
    const showOverrides = cfg.get<boolean>("codeLens.showOverrides", true);
    const showExtendedBy = cfg.get<boolean>("codeLens.showExtendedBy", true);

    // Overrides are keyed per declaring class. A 4D class file is one class, so
    // we build the map at most once per document and reuse it across functions.
    let overrideMap: Map<string, SymbolRecord[]> | undefined;
    if (showOverrides) {
      const classSym = symbols.find((s) => s.kind === SymbolKind.Class);
      if (classSym) overrideMap = overridesForClass(graph, classSym.name);
    }

    const out: vscode.CodeLens[] = [];
    for (const s of symbols) {
      if (s.kind === SymbolKind.Class) {
        out.push(...this.lensesForClass(s, docUri, showGraph, showExtendedBy, graph));
        continue;
      }
      const callerCount = graph.callers(s.id).length;
      const calleeCount = graph.callees(s.id).length;
      const line = this.mapLine(docUri, s.location.line);
      const range = new vscode.Range(line, 0, line, 1);

      if (showCallers) out.push(new vscode.CodeLens(range, {
        title: `▲ ${callerCount} callers`,
        command: "callchain.pinAndReveal",
        arguments: [s.id, "callers"]
      }));
      if (showCallees) out.push(new vscode.CodeLens(range, {
        title: `▼ ${calleeCount} callees`,
        command: "callchain.pinAndReveal",
        arguments: [s.id, "callees"]
      }));
      if (showGraph) out.push(new vscode.CodeLens(range, {
        title: `◎ Graph`,
        command: "callchain.showGraph",
        arguments: [s.id]
      }));

      // Overrides: only on `Function` declarations (plain / get / set), and only
      // when at least one descendant class redeclares this member.
      if (overrideMap && FUNCTION_KINDS.has(s.kind)) {
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

      // Tests covering this (only for non-test functions / methods)
      const isTest = s.classFlavor === ClassFlavor.Test || s.name.startsWith("test_");
      if (!isTest && coverage) {
        const tests = coverage.reachedByTests.get(s.id);
        if (tests && tests.size > 0) {
          out.push(new vscode.CodeLens(range, {
            title: `ⓘ ${tests.size} test${tests.size === 1 ? "" : "s"} cover this`,
            command: "callchain.jumpToTests",
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

      // Test result + run button on test functions
      if (s.classFlavor === ClassFlavor.Test && s.name.startsWith("test_") && s.ownerClass) {
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
    showGraph: boolean,
    showExtendedBy: boolean,
    graph: CallGraph
  ): vscode.CodeLens[] {
    const line = this.mapLine(docUri, s.location.line);
    const range = new vscode.Range(line, 0, line, 1);
    const lenses: vscode.CodeLens[] = [];
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
    if (s.classFlavor === ClassFlavor.Test) {
      lenses.push(new vscode.CodeLens(range, {
        title: `▶ Run tests for ${s.name}`,
        command: "callchain.runTestsForClass",
        arguments: [s.name]
      }));
    }
    if (showGraph) lenses.push(new vscode.CodeLens(range, {
      title: `◎ Graph class`,
      command: "callchain.showGraph",
      arguments: [s.id]
    }));
    return lenses;
  }
}

export function sameUri(a: string, b: string): boolean {
  if (!a || !b) return false;
  try { return decodeURIComponent(a) === decodeURIComponent(b); }
  catch { return a === b; }
}
