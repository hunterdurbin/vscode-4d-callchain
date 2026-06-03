import * as vscode from "vscode";
import { CallGraph } from "@4d/core";
import { sameUri } from "./callChainLens";
import { applyContentChange, countNewlines } from "./lineShift";

/**
 * Keeps call-chain CodeLenses glued to their functions while a `.4dm` /
 * `.4DForm` document is dirty. The index (and thus each symbol's saved line)
 * only updates on save, so between edits and save we track the net newlines
 * inserted/removed above each function and report the shifted line through
 * {@link displayLine}. Overrides are dropped on save / close / undo-to-clean,
 * at which point the freshly re-parsed index takes back over.
 */
export class DirtyLineTracker {
  private readonly byUri = new Map<string, Map<number, number>>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly graphGetter: () => CallGraph | undefined,
    private readonly onShift: () => void
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onChange(e)),
      vscode.workspace.onDidSaveTextDocument((doc) => this.clear(doc.uri)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.clear(doc.uri))
    );
  }

  /** Current render line for a symbol's saved line; identity when untracked. */
  displayLine(uri: string, savedLine: number): number {
    const map = this.byUri.get(uri);
    if (!map) return savedLine;
    return map.get(savedLine) ?? savedLine;
  }

  private clear(uri: vscode.Uri): void {
    if (this.byUri.delete(uri.toString())) this.onShift();
  }

  private onChange(e: vscode.TextDocumentChangeEvent): void {
    const doc = e.document;
    if (!doc.uri.path.endsWith(".4dm") && !doc.uri.path.endsWith(".4DForm")) return;

    const uriStr = doc.uri.toString();

    // Back to the saved state (e.g. undo, or post-save before the watcher
    // re-parses) — drop overrides so the index's saved lines are used.
    if (!doc.isDirty) {
      this.clear(doc.uri);
      return;
    }

    let map = this.byUri.get(uriStr);
    if (!map) {
      map = this.seed(uriStr);
      // Don't cache an empty baseline (e.g. graph not loaded yet) — leave the
      // document untracked so the next edit re-seeds once symbols exist.
      if (map.size === 0) return;
      this.byUri.set(uriStr, map);
    }

    for (const change of e.contentChanges) {
      const addedLineCount = countNewlines(change.text);
      applyContentChange(map, change.range.start.line, change.range.end.line, addedLineCount);
    }
    this.onShift();
  }

  /** Snapshot the current graph's lines for `uri` as the baseline (saved === current). */
  private seed(uriStr: string): Map<number, number> {
    const map = new Map<number, number>();
    const graph = this.graphGetter();
    if (!graph) return map;
    for (const s of graph.allSymbols()) {
      if (sameUri(s.location.uri, uriStr)) map.set(s.location.line, s.location.line);
    }
    return map;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.byUri.clear();
  }
}
