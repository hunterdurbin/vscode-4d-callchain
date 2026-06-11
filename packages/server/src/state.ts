import { Connection } from "vscode-languageserver/node";
import { Indexer, CallGraph, Logger, SymbolRecord } from "@4d/core";
import type { LintConfig } from "./lint/rule";

export class ServerState {
  indexer: Indexer | undefined;
  projectRoot: string | undefined;
  /** Current value of the `callchain.lint.rules` VSCode setting, mirrored
   *  here so the diagnostics handler doesn't need an async fetch on every
   *  publish. Refreshed on `workspace/didChangeConfiguration`. Starts
   *  empty — every rule is off-by-default. */
  lintConfig: LintConfig = {};

  constructor(public readonly connection: Connection) {}

  get graph(): CallGraph | undefined {
    return this.indexer?.getGraph();
  }

  makeLogger(): Logger {
    const conn = this.connection;
    return {
      info: (m) => conn.console.info(m),
      warn: (m) => conn.console.warn(m),
      error: (m) => conn.console.error(m)
    };
  }
}

/**
 * Word characters in 4D identifiers: alphanumerics + underscore + dot
 * (for `cs.Foo`, `ds.Bar.func` style references).
 * Note: we extract only the trailing identifier — dots split tokens upstream
 * when the user explicitly chains, but for symbol lookup we want the leaf name.
 */
export function wordAt(text: string, character: number): string | undefined {
  if (character < 0 || character > text.length) return undefined;
  const isWord = (c: string) => /[A-Za-z0-9_]/.test(c);
  let start = character;
  let end = character;
  while (start > 0 && isWord(text[start - 1])) start--;
  while (end < text.length && isWord(text[end])) end++;
  if (start === end) return undefined;
  return text.slice(start, end);
}

/**
 * Lookup all symbols matching a name (case-insensitive).
 * Filters out synthetic symbols (Builtin / TableBuiltin / Unresolved — none
 * of which carry a real source location) unless they're the only matches.
 */
export function lookupByName(graph: CallGraph, name: string): SymbolRecord[] {
  const matches = graph.byName(name);
  const real = matches.filter(
    (s) => s.kind !== "Builtin" && s.kind !== "Unresolved" && s.kind !== "TableBuiltin"
  );
  return real.length > 0 ? real : matches;
}
