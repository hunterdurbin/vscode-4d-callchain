/**
 * unused/parameter — flag declared parameters that the function body
 * never reads. Powered by Phase A's `localReads`: a param is unused when
 * it's absent from the per-symbol `localReads` map.
 *
 * Default ignores names matching `^_` so intentional placeholders like
 * `$_unused : Text` don't fire. To exempt other patterns (project-
 * specific conventions) override `ignoreNamePattern`.
 */

import { SymbolKind } from "@4d/core";
import type { LintFinding, LintRule } from "../../rule";
import { rangeForSymbol, safeRegex } from "../../util";

const APPLICABLE: Set<SymbolKind> = new Set([
  SymbolKind.ProjectMethod,
  SymbolKind.ClassFunction,
  SymbolKind.ClassConstructor,
  SymbolKind.ClassGetter,
  SymbolKind.ClassSetter,
]);

interface Options {
  ignoreNamePattern: string;
}

const RULE: LintRule<Options> = {
  id: "unused/parameter",
  theme: "unused",
  description: "Declared parameters that the function body never reads.",
  defaultSeverity: "off",
  defaultOptions: { ignoreNamePattern: "^_" },
  optionsSchema: {
    type: "object",
    properties: {
      ignoreNamePattern: {
        type: "string",
        default: "^_",
        description:
          "Parameter names matching this regex are skipped (no `$` prefix).",
      },
    },
    additionalProperties: false,
  },
  check(ctx) {
    if (!ctx.parsed) return [];
    const ignore = safeRegex(ctx.options.ignoreNamePattern);
    const findings: LintFinding[] = [];
    for (const sym of ctx.parsed.symbols) {
      if (!APPLICABLE.has(sym.kind)) continue;
      const params = sym.params;
      if (!params || params.length === 0) continue;
      const reads = ctx.parsed.localReads.get(sym.id);
      for (const p of params) {
        if (ignore && ignore.test(p.name)) continue;
        if (reads && reads.has(p.name)) continue;
        findings.push({
          range: rangeForSymbol(sym),
          message: `Parameter '$${p.name}' is declared but never read.`,
        });
      }
    }
    return findings;
  },
};

export default RULE;
