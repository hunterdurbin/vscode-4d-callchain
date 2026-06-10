import * as vscode from "vscode";
import type { SymbolRecord } from "@4d/core";
import { sameUri } from "../codelens/callChainLens";

/**
 * Draws a gutter marker on every project function that no test reaches.
 *
 * Driven by `CoverageReport.uncovered` (see testing/coverage.ts). The decorator
 * only renders when enabled via `callchain.showCoverageHints`; it mirrors the
 * editor wiring of TestStatusDecorator (active-editor + document-change), and
 * VS Code shifts decoration ranges as the document is edited, so no dirty-line
 * tracking is needed.
 */
export class CoverageHintsDecorator {
  private readonly hintType: vscode.TextEditorDecorationType;
  private enabled = false;
  private uncovered: SymbolRecord[] = [];

  constructor() {
    this.hintType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: this.icon("#d29922"),
      gutterIconSize: "70%"
    });

    vscode.window.onDidChangeActiveTextEditor((e) => e && this.apply(e));
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (ed?.document === e.document) this.apply(ed);
    });
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.refresh();
  }

  /** Replace the uncovered set (called after each coverage recompute). */
  setUncovered(uncovered: SymbolRecord[]): void {
    this.uncovered = uncovered;
    this.refresh();
  }

  private refresh(): void {
    for (const ed of vscode.window.visibleTextEditors) this.apply(ed);
  }

  apply(editor: vscode.TextEditor): void {
    if (!this.enabled || !editor.document.uri.path.endsWith(".4dm")) {
      editor.setDecorations(this.hintType, []);
      return;
    }
    const docUri = editor.document.uri.toString();
    const lineCount = editor.document.lineCount;
    const opts: vscode.DecorationOptions[] = [];
    for (const s of this.uncovered) {
      if (!sameUri(s.location.uri, docUri)) continue;
      const line = s.location.line;
      if (line < 0 || line >= lineCount) continue;
      const range = new vscode.Range(line, 0, line, 0);
      const hover = new vscode.MarkdownString();
      hover.appendMarkdown(`**${s.name}** — _no test reaches this function_`);
      opts.push({ range, hoverMessage: hover });
    }
    editor.setDecorations(this.hintType, opts);
  }

  private icon(color: string): vscode.Uri {
    // Hollow ring distinguishes "uncovered" from TestStatusDecorator's filled dots.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="none" stroke="${color}" stroke-width="2"/></svg>`;
    return vscode.Uri.parse("data:image/svg+xml;utf8," + encodeURIComponent(svg));
  }
}
