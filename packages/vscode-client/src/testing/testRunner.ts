import * as child_process from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export interface RunTestsOptions {
  projectRoot: string;
  commandTemplate: string;
  className?: string;
  output: vscode.OutputChannel;
}

export interface RunResult {
  exitCode: number;
  durationMs: number;
}

export const SCOTT_HARRIS_EXTENSION_ID = "ScottHarris.4d-testing-extension";

/**
 * True if the user has ScottHarris.4d-testing-extension installed.
 * We delegate `▶ Run` to its TestController when available.
 */
export function isScottHarrisInstalled(): boolean {
  return vscode.extensions.getExtension(SCOTT_HARRIS_EXTENSION_ID) !== undefined;
}

/**
 * Delegate to ScottHarris's Test Explorer by opening the class file at the
 * function-or-class declaration and executing VS Code's built-in
 * `testing.runCurrentFile` command. ScottHarris's TestController has already
 * discovered the file, so this picks up the right tests.
 *
 * If `testFunctionName` is provided, position the cursor at that function
 * so `testing.runAtCursor` runs just that test.
 */
export async function delegateToScottHarris(
  classFilePath: string,
  testFunctionName: string | undefined,
  output: vscode.OutputChannel
): Promise<boolean> {
  if (!isScottHarrisInstalled()) return false;
  if (!fs.existsSync(classFilePath)) {
    output.appendLine(`[Tests] delegate: missing file ${classFilePath}`);
    return false;
  }
  const uri = vscode.Uri.file(classFilePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  let line = 0;
  if (testFunctionName) {
    const text = doc.getText();
    const lines = text.split(/\r?\n/);
    const escaped = testFunctionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fnRe = new RegExp(`^\\s*Function\\s+${escaped}\\s*\\(`);
    for (let i = 0; i < lines.length; i++) {
      if (fnRe.test(lines[i])) { line = i; break; }
    }
  }
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0) });
  // `testing.runCurrentFile` runs every test in the active file; for a single
  // test, `testing.runAtCursor` uses the cursor position we just set.
  const cmd = testFunctionName ? "testing.runAtCursor" : "testing.runCurrentFile";
  await vscode.commands.executeCommand(cmd);
  output.appendLine(`[Tests] Delegated to ScottHarris (${cmd}) for ${path.basename(classFilePath)}${testFunctionName ? ` :: ${testFunctionName}` : ""}`);
  return true;
}

export function runTests(opts: RunTestsOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const className = opts.className ?? "";
    const command = opts.commandTemplate.replace(/\{class\}/g, className);
    opts.output.show(true);
    opts.output.appendLine(`\n$ ${command}    [cwd=${opts.projectRoot}]`);
    const started = Date.now();
    const child = child_process.spawn("sh", ["-c", command], { cwd: opts.projectRoot });
    child.stdout.on("data", (chunk) => opts.output.append(chunk.toString()));
    child.stderr.on("data", (chunk) => opts.output.append(chunk.toString()));
    child.on("close", (code) => {
      const durationMs = Date.now() - started;
      opts.output.appendLine(`\n[exit ${code} in ${(durationMs / 1000).toFixed(1)}s]`);
      resolve({ exitCode: code ?? -1, durationMs });
    });
    child.on("error", (err) => {
      opts.output.appendLine(`\n[spawn error] ${err.message}`);
      resolve({ exitCode: -1, durationMs: Date.now() - started });
    });
  });
}
