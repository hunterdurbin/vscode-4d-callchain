import * as vscode from "vscode";
import { CallGraph } from "@4d/core";
import { CoverageHintsDecorator } from "../decorations/coverageHintsDecorator";
import {
  CoverageReport,
  computeCoverage,
  DEFAULT_TEST_FUNCTION_PATTERN,
  DEFAULT_TEST_CLASS_PATTERN,
  DEFAULT_TEST_METHOD_PATTERN,
  type TestPatterns
} from "../testing/coverage";

/**
 * Owns the coverage report (which tests reach which symbols), the
 * test-detection patterns, and the gutter hints decorator. Coverage is
 * skipped entirely when neither test integration nor coverage hints need it.
 */
export class CoverageService {
  private report: CoverageReport | undefined;
  private patterns: TestPatterns;
  private hintsEnabled: boolean;
  private readonly hints = new CoverageHintsDecorator();

  constructor(
    private readonly graphGetter: () => CallGraph | undefined,
    private readonly testEnabled: boolean,
    private readonly output: vscode.OutputChannel
  ) {
    this.hintsEnabled = vscode.workspace.getConfiguration("callchain").get<boolean>("showCoverageHints", false);
    this.patterns = this.compilePatterns();
  }

  /** The current report; undefined while coverage is disabled or not yet computed. */
  get(): CoverageReport | undefined {
    return this.report;
  }

  getPatterns(): TestPatterns {
    return this.patterns;
  }

  /**
   * Recompute coverage from the current graph and push it to the consumers.
   * Used both on index updates and on coverage-related config changes so the
   * two paths can never disagree.
   */
  recompute(graph = this.graphGetter()): void {
    if (graph && (this.testEnabled || this.hintsEnabled)) {
      this.report = computeCoverage(graph, this.patterns);
    } else {
      this.report = undefined;
    }
    this.hints.setUncovered(this.report?.uncovered ?? []);
    this.hints.setEnabled(this.hintsEnabled);
  }

  /** Re-read the hint toggle + patterns from settings and recompute. */
  refreshFromConfig(): void {
    this.hintsEnabled = vscode.workspace.getConfiguration("callchain").get<boolean>("showCoverageHints", false);
    this.patterns = this.compilePatterns();
    this.recompute();
  }

  private compilePatterns(): TestPatterns {
    const ccfg = vscode.workspace.getConfiguration("callchain");
    const compile = (key: string, fallback: RegExp): RegExp => {
      const raw = ccfg.get<string>(key, "");
      if (!raw) return fallback;
      try {
        return new RegExp(raw);
      } catch (e) {
        this.output.appendLine(`[Coverage] Invalid regex for callchain.${key} ("${raw}"): ${(e as Error).message}. Using default.`);
        return fallback;
      }
    };
    return {
      testFunctionPattern: compile("coverage.testFunctionPattern", DEFAULT_TEST_FUNCTION_PATTERN),
      testClassPattern: compile("coverage.testClassPattern", DEFAULT_TEST_CLASS_PATTERN),
      testMethodPattern: compile("coverage.testMethodPattern", DEFAULT_TEST_METHOD_PATTERN)
    };
  }
}
