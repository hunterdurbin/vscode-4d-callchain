import * as vscode from "vscode";
import { CallGraph } from "../model/callGraph";
import { ClassFlavor, SymbolKind, SymbolRecord } from "../model/symbol";
import { TestStatusDecorator } from "../decorations/testStatusDecorator";
import { CoverageReport } from "../testing/coverage";

export class CallChainLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(
    private graphGetter: () => CallGraph | undefined,
    private testStatusGetter: () => TestStatusDecorator,
    private coverageGetter: () => CoverageReport | undefined
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!doc.uri.path.endsWith(".4dm")) return [];
    const graph = this.graphGetter();
    if (!graph) return [];

    const docUri = doc.uri.toString();
    const symbols = graph.allSymbols().filter((s) => sameUri(s.location.uri, docUri));
    if (symbols.length === 0) return [];

    const decorator = this.testStatusGetter();
    const coverage = this.coverageGetter();

    const out: vscode.CodeLens[] = [];
    for (const s of symbols) {
      if (s.kind === SymbolKind.Class) {
        out.push(...this.lensesForClass(s));
        continue;
      }
      if (s.kind === SymbolKind.ClassConstructor) continue;
      const callerCount = graph.callers(s.id).length;
      const calleeCount = graph.callees(s.id).length;
      const range = new vscode.Range(s.location.line, 0, s.location.line, 1);

      out.push(new vscode.CodeLens(range, {
        title: `▲ ${callerCount} callers`,
        command: "callchain.pinAndReveal",
        arguments: [s.id, "callers"]
      }));
      out.push(new vscode.CodeLens(range, {
        title: `▼ ${calleeCount} callees`,
        command: "callchain.pinAndReveal",
        arguments: [s.id, "callees"]
      }));
      out.push(new vscode.CodeLens(range, {
        title: `◎ Graph`,
        command: "callchain.showGraph",
        arguments: [s.id]
      }));

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

  private lensesForClass(s: SymbolRecord): vscode.CodeLens[] {
    const range = new vscode.Range(s.location.line, 0, s.location.line, 1);
    const lenses: vscode.CodeLens[] = [];
    if (s.classFlavor === ClassFlavor.Test) {
      lenses.push(new vscode.CodeLens(range, {
        title: `▶ Run tests for ${s.name}`,
        command: "callchain.runTestsForClass",
        arguments: [s.name]
      }));
    }
    lenses.push(new vscode.CodeLens(range, {
      title: `◎ Graph class`,
      command: "callchain.showGraph",
      arguments: [s.id]
    }));
    return lenses;
  }
}

function sameUri(a: string, b: string): boolean {
  if (!a || !b) return false;
  try { return decodeURIComponent(a) === decodeURIComponent(b); }
  catch { return a === b; }
}
