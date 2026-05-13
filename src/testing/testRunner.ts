import * as child_process from "child_process";
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
