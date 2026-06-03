/**
 * types/missing-return-type — flag functions and getters that don't
 * declare a return type. Skips constructors and setters (no return) and
 * Project Methods written in the legacy procedure-style with no
 * `#DECLARE(...) -> $r : T` arrow form.
 *
 * No options. Project methods that never `return` or set `$0` aren't
 * flagged — there's no signal in the index that they "should" return.
 * We only flag declarations whose syntax position COULD carry a return
 * type but doesn't.
 */

import { SymbolKind } from "@4d/core";
import type { LintFinding, LintRule } from "../../rule";
import { rangeForSymbol } from "../../util";

const APPLICABLE: Set<SymbolKind> = new Set([
  SymbolKind.ClassFunction,
  SymbolKind.ClassGetter,
]);

interface Options {}

const RULE: LintRule<Options> = {
  id: "types/missing-return-type",
  theme: "types",
  description:
    "Class functions and getters without a declared return type (`: T`).",
  defaultSeverity: "off",
  defaultOptions: {},
  optionsSchema: { type: "object", additionalProperties: false },
  check(ctx) {
    if (!ctx.parsed) return [];
    const findings: LintFinding[] = [];
    for (const sym of ctx.parsed.symbols) {
      if (!APPLICABLE.has(sym.kind)) continue;
      if (sym.returnType) continue;
      findings.push({
        range: rangeForSymbol(sym),
        message:
          sym.kind === SymbolKind.ClassGetter
            ? `Getter '${sym.name}' has no declared return type.`
            : `Function '${sym.name}' has no declared return type.`,
      });
    }
    return findings;
  },
};

export default RULE;
