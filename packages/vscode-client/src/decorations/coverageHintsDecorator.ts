import * as vscode from "vscode";
import type { SymbolRecord } from "@4d/core";
import { debounce } from "../util/debounce";

/**
 * Draws a gutter marker on every project function that no test reaches.
 *
 * Driven by `CoverageReport.uncovered` (see testing/coverage.ts). The decorator
 * only renders when enabled via the coverage-hints setting; it mirrors the
 * editor wiring of TestStatusDecorator (active-editor + document-change), and
 * VS Code shifts decoration ranges as the document is edited, so no dirty-line
 * tracking is needed.
 */
export class CoverageHintsDecorator implements vscode.Disposable {
  private readonly hintType: vscode.TextEditorDecorationType;
  private enabled = false;
  /** Uncovered symbols bucketed by decoded document uri, so `apply` is
   *  O(file symbols) instead of scanning (and decoding) the whole list on
   *  every editor event. */
  private uncoveredByUri = new Map<string, SymbolRecord[]>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.hintType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: this.icon("#d29922"),
      gutterIconSize: "70%"
    });

    const applyDebounced = debounce((ed: vscode.TextEditor) => this.apply(ed), 150);
    this.disposables.push(
      this.hintType,
      vscode.window.onDidChangeActiveTextEditor((e) => e && this.apply(e)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (!this.enabled) return;
        const ed = vscode.window.activeTextEditor;
        if (ed?.document === e.document) applyDebounced(ed);
      })
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.refresh();
  }

  /** Replace the uncovered set (called after each coverage recompute). */
  setUncovered(uncovered: SymbolRecord[]): void {
    this.uncoveredByUri = new Map();
    for (const s of uncovered) {
      if (!s.location.uri) continue;
      const key = decodeUri(s.location.uri);
      const list = this.uncoveredByUri.get(key) ?? [];
      list.push(s);
      this.uncoveredByUri.set(key, list);
    }
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
    const fileSymbols = this.uncoveredByUri.get(decodeUri(editor.document.uri.toString())) ?? [];
    const lineCount = editor.document.lineCount;
    const opts: vscode.DecorationOptions[] = [];
    for (const s of fileSymbols) {
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

function decodeUri(uri: string): string {
  try { return decodeURIComponent(uri); }
  catch { return uri; }
}
