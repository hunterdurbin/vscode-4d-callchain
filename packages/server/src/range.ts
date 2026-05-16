import { Range } from "vscode-languageserver/node";
import { FileLocation, SymbolRecord } from "@4d/core";

/**
 * LSP Range for a symbol's identifier. Uses column + endColumn when present
 * to give a precise word-level highlight; falls back to a line-level range
 * for file-level symbols that don't have a meaningful column.
 */
export function rangeForLocation(loc: FileLocation, fallbackName?: string): Range {
  const startChar = loc.column ?? 0;
  if (loc.column !== undefined) {
    const endChar = loc.endColumn ?? (loc.column + (fallbackName?.length ?? 0));
    return {
      start: { line: loc.line, character: startChar },
      end: { line: loc.line, character: endChar }
    };
  }
  // No column → fall back to a line-spanning range, capped at the same line
  // when endLine isn't set (avoid `start === end` so VSCode renders a real range).
  const endLine = loc.endLine ?? loc.line;
  return {
    start: { line: loc.line, character: 0 },
    end: { line: endLine, character: fallbackName ? fallbackName.length : 0 }
  };
}

export function rangeForSymbol(s: SymbolRecord): Range {
  return rangeForLocation(s.location, s.name);
}
