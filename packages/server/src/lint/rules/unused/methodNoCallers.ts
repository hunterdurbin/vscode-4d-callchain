/**
 * unused/method-no-callers — flag "public" methods that no other code in
 * the project calls.
 *
 * "Public" defaults to project methods + class functions whose name does
 * NOT start with `_`. The `publicPattern` option lets the user override
 * what counts as public; `entrypoints` is an explicit allowlist of names
 * that are intentionally called by the framework / lifecycle / RPC; and
 * `entrypointPattern` is a regex catch-all (default `^On ` matches 4D
 * form events and `On Startup` / `On Exit` style callbacks).
 *
 * Queries the `CallGraph`. Skips when graph is unavailable (cold load
 * before index is built).
 */

import { SymbolKind } from "@4d/core";
import type { LintFinding, LintRule } from "../../rule";
import { rangeForSymbol, safeRegex } from "../../util";

const FILE_LEVEL_PUBLIC: Set<SymbolKind> = new Set([
  SymbolKind.ProjectMethod,
  SymbolKind.ClassFunction,
]);

interface Options {
  /** Regex applied to the symbol name. Symbols matching it are
   *  considered "public" and are candidates for the check. Default
   *  `^[^_]` excludes names starting with an underscore. */
  publicPattern: string;
  /** Explicit allowlist of method/function names. Names in this list are
   *  never flagged, regardless of caller count. Use for known entrypoints
   *  the indexer can't see (RPC handlers, schedulers, …). */
  entrypoints: string[];
  /** Regex pattern applied to the symbol name. Matches are treated as
   *  entrypoints and skipped. Default `^On ` covers form events and
   *  lifecycle callbacks (`On Startup`, `On Exit`, `On Web Connection`). */
  entrypointPattern: string;
}

const RULE: LintRule<Options> = {
  id: "unused/method-no-callers",
  theme: "unused",
  description:
    "Public project methods / class functions with no callers anywhere in the project.",
  defaultSeverity: "off",
  defaultOptions: {
    publicPattern: "^[^_]",
    entrypoints: [],
    entrypointPattern: "^On ",
  },
  optionsSchema: {
    type: "object",
    properties: {
      publicPattern: { type: "string", default: "^[^_]" },
      entrypoints: { type: "array", items: { type: "string" }, default: [] },
      entrypointPattern: { type: "string", default: "^On " },
    },
    additionalProperties: false,
  },
  check(ctx) {
    if (!ctx.parsed || !ctx.callGraph) return [];
    const publicRe = safeRegex(ctx.options.publicPattern);
    const entryRe = safeRegex(ctx.options.entrypointPattern);
    const entryNames = new Set(ctx.options.entrypoints ?? []);
    const findings: LintFinding[] = [];
    for (const sym of ctx.parsed.symbols) {
      if (!FILE_LEVEL_PUBLIC.has(sym.kind)) continue;
      if (publicRe && !publicRe.test(sym.name)) continue;
      if (entryNames.has(sym.name)) continue;
      if (entryRe && entryRe.test(sym.name)) continue;
      const callers = ctx.callGraph.callers(sym.id);
      if (callers.length > 0) continue;
      findings.push({
        range: rangeForSymbol(sym),
        message:
          sym.kind === SymbolKind.ClassFunction
            ? `Class function '${sym.name}' has no callers.`
            : `Project method '${sym.name}' has no callers.`,
      });
    }
    return findings;
  },
};

export default RULE;
