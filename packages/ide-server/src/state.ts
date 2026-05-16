import { Connection } from "vscode-languageserver/node";
import { Indexer, CallGraph, Logger, SymbolRecord } from "@4d/core";

export class ServerState {
  indexer: Indexer | undefined;
  projectRoot: string | undefined;

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
 * Extract the word at `character` in `text`. 4D identifiers are alphanumerics
 * + underscore. Returns undefined when the position isn't on an identifier.
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

/** Lookup all symbols matching a name (case-insensitive). Builtins/Unresolved last. */
export function lookupByName(graph: CallGraph, name: string): SymbolRecord[] {
  const matches = graph.byName(name);
  const real = matches.filter((s) => s.kind !== "Builtin" && s.kind !== "Unresolved" && s.kind !== "TableBuiltin");
  return real.length > 0 ? real : matches;
}
