import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { TestStatusDecorator } from "../decorations/testStatusDecorator";

/**
 * Watches for test-result files in two locations:
 *
 *  1. **Persistent**: our own output path (default
 *     `Components/testing.4dbase/test-results/results.json`). We own this file;
 *     it survives across runs and gets fully reloaded on change.
 *
 *  2. **Transient**: ScottHarris.4d-testing-extension writes
 *     `.4d-testing-extension/results-<ts>.json` then immediately deletes it
 *     once results land in its TestController. We race the delete by reading
 *     on `onDidCreate` and merging into the decorator.
 *
 *  Both formats are the SAME JSON shape (testResults[]), so a single parser
 *  handles both.
 */
export class TestResultsWatcher {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly projectRoot: string,
    private readonly decorator: TestStatusDecorator,
    private readonly output: vscode.OutputChannel
  ) {}

  start(): void {
    const cfg = vscode.workspace.getConfiguration("callchain");
    const jsonRel = cfg.get<string>("jsonResultsPath", "Components/testing.4dbase/test-results/results.json");
    const junitRel = cfg.get<string>("junitResultsPath", "Components/testing.4dbase/test-results/junit.xml");

    // Initial load — prefer JSON over JUnit if both exist.
    const jsonAbs = path.join(this.projectRoot, jsonRel);
    const junitAbs = path.join(this.projectRoot, junitRel);
    if (fs.existsSync(jsonAbs)) {
      this.decorator.loadFromJson(jsonAbs);
      this.output.appendLine(`[Tests] Loaded ${jsonAbs}`);
    } else if (fs.existsSync(junitAbs)) {
      this.decorator.loadFromJunit(junitAbs);
      this.output.appendLine(`[Tests] Loaded ${junitAbs} (JUnit fallback)`);
    }

    // Watch persistent JSON.
    if (jsonRel) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.projectRoot, jsonRel));
      w.onDidCreate(() => this.decorator.loadFromJson(jsonAbs));
      w.onDidChange(() => this.decorator.loadFromJson(jsonAbs));
      this.disposables.push(w);
    }

    // Watch persistent JUnit (fallback).
    if (junitRel) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.projectRoot, junitRel));
      w.onDidCreate(() => {
        if (!fs.existsSync(jsonAbs)) this.decorator.loadFromJunit(junitAbs);
      });
      w.onDidChange(() => {
        if (!fs.existsSync(jsonAbs)) this.decorator.loadFromJunit(junitAbs);
      });
      this.disposables.push(w);
    }

    // Watch ScottHarris's transient files. They appear briefly, get parsed,
    // then are unlinked. We read them on create and merge into the decorator.
    const transient = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.projectRoot, ".4d-testing-extension/results-*.json")
    );
    transient.onDidCreate((uri) => {
      // Read immediately — ScottHarris deletes after parsing, ~100ms-1s later.
      // Try with one short retry to handle race where file is being written.
      const tryLoad = (attempt: number) => {
        try {
          if (fs.existsSync(uri.fsPath) && fs.statSync(uri.fsPath).size > 0) {
            this.decorator.mergeFromJson(uri.fsPath);
            this.output.appendLine(`[Tests] Snapshot ${path.basename(uri.fsPath)} (from ScottHarris)`);
            return;
          }
        } catch { /* ignore */ }
        if (attempt < 3) setTimeout(() => tryLoad(attempt + 1), 100);
      };
      tryLoad(0);
    });
    this.disposables.push(transient);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
