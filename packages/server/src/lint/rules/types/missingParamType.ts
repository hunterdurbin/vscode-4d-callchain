/**
 * types/missing-param-type — flag function/method/constructor params that
 * don't have a declared type. Type annotations help the chain resolver
 * (e.g., `$x.foo()` needs `$x : cs.Bar`) and document intent.
 *
 * No options. Skips parameters whose name starts with `_` so intentional
 * placeholders aren't surfaced.
 */

import { SymbolKind } from "@4d/core";
import type { LintFinding, LintRule } from "../../rule";
import { rangeForSymbol } from "../../util";

const APPLICABLE: Set<SymbolKind> = new Set([
  SymbolKind.ProjectMethod,
  SymbolKind.ClassFunction,
  SymbolKind.ClassConstructor,
  SymbolKind.ClassGetter,
  SymbolKind.ClassSetter,
]);

interface Options {}

const RULE: LintRule<Options> = {
  id: "types/missing-param-type",
  theme: "types",
  description: "Function / method parameters without a declared type.",
  defaultSeverity: "off",
  defaultOptions: {},
  optionsSchema: { type: "object", additionalProperties: false },
  check(ctx) {
    if (!ctx.parsed) return [];
    const findings: LintFinding[] = [];
    for (const sym of ctx.parsed.symbols) {
      if (!APPLICABLE.has(sym.kind)) continue;
      const params = sym.params;
      if (!params || params.length === 0) continue;
      for (const p of params) {
        if (p.type) continue;
        // Convention: leading underscore = intentional placeholder.
        if (p.name.startsWith("_")) continue;
        findings.push({
          range: rangeForSymbol(sym),
          message: `Parameter '$${p.name}' has no declared type.`,
        });
      }
    }
    return findings;
  },
};

export default RULE;
