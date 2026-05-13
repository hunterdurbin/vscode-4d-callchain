import * as vscode from "vscode";
import { JUnitParseResult, TestResult, indexByClass, parseJUnitFile } from "../testing/junitParser";

interface DecoratorState {
  byClass: Map<string, Map<string, TestResult>>;
  lastParsed?: JUnitParseResult;
}

export class TestStatusDecorator {
  private state: DecoratorState = { byClass: new Map() };
  private readonly passType: vscode.TextEditorDecorationType;
  private readonly failType: vscode.TextEditorDecorationType;
  private readonly errorType: vscode.TextEditorDecorationType;
  private readonly skipType: vscode.TextEditorDecorationType;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor() {
    this.passType  = vscode.window.createTextEditorDecorationType({
      gutterIconPath: this.icon("#3fb950"),
      gutterIconSize: "70%",
      after: { color: new vscode.ThemeColor("descriptionForeground"), margin: "0 0 0 12px" }
    });
    this.failType  = vscode.window.createTextEditorDecorationType({
      gutterIconPath: this.icon("#f85149"),
      gutterIconSize: "70%",
      after: { color: new vscode.ThemeColor("errorForeground"), margin: "0 0 0 12px" }
    });
    this.errorType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: this.icon("#ff8c00"),
      gutterIconSize: "70%",
      after: { color: new vscode.ThemeColor("errorForeground"), margin: "0 0 0 12px" }
    });
    this.skipType  = vscode.window.createTextEditorDecorationType({
      gutterIconPath: this.icon("#888888"),
      gutterIconSize: "70%"
    });

    vscode.window.onDidChangeActiveTextEditor((e) => e && this.apply(e));
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (ed?.document === e.document) this.apply(ed);
    });
  }

  loadFrom(filePath: string): void {
    const result = parseJUnitFile(filePath);
    if (!result) {
      this.state = { byClass: new Map() };
    } else {
      this.state = { lastParsed: result, byClass: indexByClass(result.results) };
    }
    for (const ed of vscode.window.visibleTextEditors) this.apply(ed);
    this.emitter.fire();
  }

  resultFor(className: string, testName: string): TestResult | undefined {
    return this.state.byClass.get(className)?.get(testName);
  }

  totals(): { tests: number; failures: number; errors: number; skipped: number } | undefined {
    return this.state.lastParsed?.totals;
  }

  apply(editor: vscode.TextEditor): void {
    if (!editor.document.uri.path.endsWith(".4dm")) {
      editor.setDecorations(this.passType, []);
      editor.setDecorations(this.failType, []);
      editor.setDecorations(this.errorType, []);
      editor.setDecorations(this.skipType, []);
      return;
    }
    const fileName = editor.document.fileName.split(/[\\/]/).pop() ?? "";
    if (!fileName.endsWith("_Test.4dm") && !/Test\.4dm$/i.test(fileName)) {
      // Skip non-test files
      return;
    }
    const className = fileName.replace(/\.4dm$/, "");
    const bucket = this.state.byClass.get(className);
    if (!bucket || bucket.size === 0) return;

    const text = editor.document.getText();
    const lines = text.split(/\r?\n/);
    const fnRe = /^\s*Function\s+(test_[\w_]+)\s*\(/;
    const pass: vscode.DecorationOptions[] = [];
    const fail: vscode.DecorationOptions[] = [];
    const err: vscode.DecorationOptions[] = [];
    const skip: vscode.DecorationOptions[] = [];

    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(fnRe);
      if (!m) continue;
      const result = bucket.get(m[1]);
      if (!result) continue;
      const range = new vscode.Range(i, 0, i, lines[i].length);
      const hover = new vscode.MarkdownString();
      hover.appendMarkdown(`**${result.testName}** — _${result.status}_`);
      if (result.durationMs !== undefined) hover.appendMarkdown(` · ${Math.round(result.durationMs)}ms`);
      if (result.message) {
        hover.appendMarkdown("\n\n");
        hover.appendCodeblock(result.message, "text");
      }
      const opt: vscode.DecorationOptions = {
        range,
        hoverMessage: hover,
        renderOptions: {
          after: {
            contentText: result.status === "passed"
              ? `✓ ${Math.round(result.durationMs ?? 0)}ms`
              : `✗ ${result.status}`
          }
        }
      };
      switch (result.status) {
        case "passed": pass.push(opt); break;
        case "failed": fail.push(opt); break;
        case "errored": err.push(opt); break;
        case "skipped": skip.push(opt); break;
      }
    }
    editor.setDecorations(this.passType, pass);
    editor.setDecorations(this.failType, fail);
    editor.setDecorations(this.errorType, err);
    editor.setDecorations(this.skipType, skip);
  }

  private icon(color: string): vscode.Uri {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="${color}"/></svg>`;
    return vscode.Uri.parse("data:image/svg+xml;utf8," + encodeURIComponent(svg));
  }
}
