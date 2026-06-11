import * as path from "path";
import * as vscode from "vscode";
import { Indexer } from "@4d/core";
import { TestStatusDecorator } from "../decorations/testStatusDecorator";
import { TestResultsWatcher } from "./resultsWatcher";
import { delegateToScottHarris, isScottHarrisInstalled, runTests } from "./testRunner";
import { CoverageService } from "../coverage/coverageService";
import { openSymbol } from "../commands/navigationCommands";
import * as config from "../config";

/**
 * The optional test-integration subsystem: results watcher, pass/fail gutter
 * decorations, run commands, and ScottHarris.4d-testing-extension delegation.
 * Registered only when `callchain.testIntegration.enabled` is on — when off,
 * none of this is constructed and the Run/coverage lenses never light up.
 */
export function registerTestIntegration(
  context: vscode.ExtensionContext,
  projectRoot: string,
  indexer: Indexer,
  decorator: TestStatusDecorator,
  coverage: CoverageService,
  output: vscode.OutputChannel,
  testOutput: vscode.OutputChannel
): void {
  // Test-results watcher: persistent JSON path + ScottHarris's transient files.
  const resultsWatcher = new TestResultsWatcher(projectRoot, decorator, output);
  resultsWatcher.start();
  context.subscriptions.push(resultsWatcher);

  if (isScottHarrisInstalled()) {
    output.appendLine("[Activate] ScottHarris.4d-testing-extension detected — ▶ Run will delegate to its Test Explorer.");
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("callchain.runTestsForClass", async (className?: string, testFunctionName?: string) => {
      const cls = className ?? (await vscode.window.showInputBox({ prompt: "Test class name (e.g. OrderHydrator_Test)" }));
      if (!cls) return;
      // 1. If ScottHarris is installed, delegate to its Test Explorer.
      if (isScottHarrisInstalled()) {
        const classFile = path.join(projectRoot, "Project", "Sources", "Classes", `${cls}.4dm`);
        const ok = await delegateToScottHarris(classFile, testFunctionName, testOutput);
        if (ok) return;
      }
      // 2. Fall back to our own runner.
      const jsonRel = config.jsonResultsPath();
      const cmd = config.testCommand().replace(/\{jsonOutputPath\}/g, jsonRel);
      await runTests({ projectRoot, commandTemplate: cmd, className: cls, output: testOutput });
      const jsonAbs = path.join(projectRoot, jsonRel);
      decorator.loadFromJson(jsonAbs);
    }),
    vscode.commands.registerCommand("callchain.runAllTests", async () => {
      if (isScottHarrisInstalled()) {
        // Run all 4D tests in the global Test Explorer.
        await vscode.commands.executeCommand("testing.runAll");
        return;
      }
      const jsonRel = config.jsonResultsPath();
      const cmd = config.testCommand()
        .replace(/\bclass=\{class\}\s*/g, "")
        .replace(/\{jsonOutputPath\}/g, jsonRel);
      await runTests({ projectRoot, commandTemplate: cmd, output: testOutput });
      const jsonAbs = path.join(projectRoot, jsonRel);
      decorator.loadFromJson(jsonAbs);
    }),
    vscode.commands.registerCommand("callchain.jumpToTests", async (symbolId: string) => {
      const report = coverage.get();
      if (!report) return;
      const graph = indexer.getGraph();
      if (!graph) return;
      const tests = report.reachedByTests.get(symbolId);
      if (!tests || tests.size === 0) {
        vscode.window.showInformationMessage("No tests reach this symbol.");
        return;
      }
      const items = Array.from(tests).map((id) => {
        const s = graph.symbol(id);
        return {
          label: s?.name ?? id,
          description: s?.ownerClass ?? "",
          detail: s?.location.uri ?? "",
          symbol: s
        };
      });
      const picked = await vscode.window.showQuickPick(items, { placeHolder: `${tests.size} tests cover this symbol` });
      if (picked?.symbol) await openSymbol(picked.symbol);
    })
  );
}
