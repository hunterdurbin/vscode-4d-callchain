/**
 * Shared helpers for lint rules.
 */

import type { SymbolRecord } from "@4d/core";
import type { LintFinding } from "./rule";

/**
 * Build a `LintFinding.range` from a symbol's identifier location. Falls
 * back to a single-line whole-line range when column info isn't available
 * (file-level symbols where `location.line === 0` and there's no column).
 */
export function rangeForSymbol(symbol: SymbolRecord): LintFinding["range"] {
  const line = symbol.location.line ?? 0;
  const column = symbol.location.column;
  const endColumn = symbol.location.endColumn;
  if (column !== undefined && endColumn !== undefined && endColumn > column) {
    return {
      start: { line, character: column },
      end: { line, character: endColumn },
    };
  }
  // No column info — squiggle the whole line range (0..120 is a stable
  // single-line marker without needing the source).
  return {
    start: { line, character: 0 },
    end: { line, character: 120 },
  };
}

/**
 * Convert a `LocalUsageSite` (`{ line, column, endColumn }`) to a
 * `LintFinding.range`.
 */
export function rangeForUsage(usage: {
  line: number;
  column: number;
  endColumn: number;
}): LintFinding["range"] {
  return {
    start: { line: usage.line, character: usage.column },
    end: { line: usage.line, character: usage.endColumn },
  };
}

/**
 * Compile a string into a `RegExp`, returning `null` on a bad pattern.
 * Rule options that accept user-provided regex source (e.g.,
 * `ignoreNamePattern`) call this so a typo in settings can't crash the
 * rule.
 */
export function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}
