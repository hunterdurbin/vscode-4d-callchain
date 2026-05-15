import * as vscode from "vscode";
import { CallGraph, SymbolKind } from "@4d/core";
import type { SymbolRecord } from "@4d/core";
import { debounce } from "../util/debounce";

/**
 * Maps an editor position to a symbol from the index — file URI + line bracketing.
 * For classes, picks the deepest function whose definition line <= cursor line.
 */
export class CursorTracker {
  private graph: CallGraph | undefined;
  private readonly emitter = new vscode.EventEmitter<SymbolRecord | undefined>();
  readonly onDidChange = this.emitter.event;
  private current: SymbolRecord | undefined;

  constructor() {
    const debounced = debounce(() => this.recompute(), 200);
    vscode.window.onDidChangeActiveTextEditor(() => debounced());
    vscode.window.onDidChangeTextEditorSelection(() => debounced());
  }

  setGraph(graph: CallGraph): void {
    this.graph = graph;
    this.recompute();
  }

  pin(symbol: SymbolRecord): void {
    this.current = symbol;
    this.emitter.fire(symbol);
  }

  getCurrent(): SymbolRecord | undefined {
    return this.current;
  }

  private recompute(): void {
    if (!this.graph) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.emit(undefined);
      return;
    }
    const filePath = editor.document.uri.path;
    if (editor.document.languageId !== "4d" && !filePath.endsWith(".4dm") && !filePath.endsWith(".4DForm")) {
      this.emit(undefined);
      return;
    }
    const uri = editor.document.uri.toString();
    const line = editor.selection.active.line;
    const candidates = this.graph.allSymbols().filter((s) => sameUri(s.location.uri, uri));
    if (candidates.length === 0) {
      this.emit(undefined);
      return;
    }
    let best: SymbolRecord | undefined;
    for (const c of candidates) {
      if (c.location.line <= line && (!best || c.location.line > best.location.line)) {
        best = c;
      }
    }
    if (!best) {
      // Fall back to the file-level method symbol (line 0)
      best = candidates.find((s) =>
        [SymbolKind.ProjectMethod, SymbolKind.DatabaseMethod, SymbolKind.FormMethod, SymbolKind.TableFormMethod,
         SymbolKind.FormObjectMethod, SymbolKind.TableObjectMethod, SymbolKind.CompilerMethod].includes(s.kind)
      );
    }
    this.emit(best);
  }

  private emit(s: SymbolRecord | undefined): void {
    if (s?.id === this.current?.id) return;
    this.current = s;
    this.emitter.fire(s);
  }
}

function sameUri(a: string, b: string): boolean {
  if (!a || !b) return false;
  try {
    return decodeURIComponent(a) === decodeURIComponent(b);
  } catch {
    return a === b;
  }
}
