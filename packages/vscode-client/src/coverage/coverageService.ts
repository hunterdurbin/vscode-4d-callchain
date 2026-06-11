import * as vscode from "vscode";
import { CallGraph } from "@4d/core";
import { CoverageHintsDecorator } from "../decorations/coverageHintsDecorator";
import { TrailingScheduler } from "../util/trailingScheduler";
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
 * test-detection patterns, and the gutter hints decorator.
 *
 * Coverage is a full DFS from every test seed over the whole call graph —
 * too expensive to run synchronously inside the indexer's onDidUpdate (i.e.
 * on every save, on the thread every extension shares). Index updates
 * therefore only `invalidate()`; the compute runs once on a trailing timer
 * after the save burst settles, and `onDidCompute` lets consumers (lenses)
 * re-render with the fresh report. `get()` serves the cached — possibly one
 * update stale — report in the meantime. When neither test integration nor
 * coverage hints are enabled, nothing is ever computed.
 */
export class CoverageService implements vscode.Disposable {
  private report: CoverageReport | undefined;
  private patterns: TestPatterns;
  private hintsEnabled: boolean;
  private readonly hints = new CoverageHintsDecorator();
  private readonly scheduler: TrailingScheduler;
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires after each (re)compute lands — consumers re-render from `get()`. */
  readonly onDidCompute = this.emitter.event;

  constructor(
    private readonly graphGetter: () => CallGraph | undefined,
    private readonly testEnabled: boolean,
    private readonly output: vscode.OutputChannel,
    computeDelayMs = 1500
  ) {
    this.hintsEnabled = vscode.workspace.getConfiguration("callchain").get<boolean>("showCoverageHints", false);
    this.patterns = this.compilePatterns();
    this.scheduler = new TrailingScheduler(() => this.computeNow(), computeDelayMs);
  }

  dispose(): void {
    this.scheduler.cancel();
    this.hints.dispose();
    this.emitter.dispose();
  }

  /** The current (possibly one-update-stale) report; undefined while disabled. */
  get(): CoverageReport | undefined {
    return this.report;
  }

  getPatterns(): TestPatterns {
    return this.patterns;
  }

  private get enabled(): boolean {
    return this.testEnabled || this.hintsEnabled;
  }

  /**
   * Mark the report stale after an index update. Schedules the (expensive)
   * recompute on the trailing timer; a burst of saves computes once.
   */
  invalidate(): void {
    if (!this.enabled) {
      this.report = undefined;
      this.pushToHints();
      return;
    }
    this.scheduler.schedule();
  }

  /** Re-read the hint toggle + patterns from settings and recompute promptly
   *  (config changes are rare and user-initiated — they expect to see the
   *  effect now, not after the idle delay). */
  refreshFromConfig(): void {
    this.hintsEnabled = vscode.workspace.getConfiguration("callchain").get<boolean>("showCoverageHints", false);
    this.patterns = this.compilePatterns();
    this.scheduler.cancel();
    this.computeNow();
  }

  private computeNow(): void {
    const graph = this.graphGetter();
    if (graph && this.enabled) {
      this.report = computeCoverage(graph, this.patterns);
    } else {
      this.report = undefined;
    }
    this.pushToHints();
    this.emitter.fire();
  }

  private pushToHints(): void {
    this.hints.setUncovered(this.report?.uncovered ?? []);
    this.hints.setEnabled(this.hintsEnabled);
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
