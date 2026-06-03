/**
 * style/method-camel-case — flag method/function names that don't match
 * the project's casing convention.
 *
 * Default `^[a-z][A-Za-z0-9_]*$` (lower-camel) with `allowUnderscorePrefix`
 * letting `_privateName` pass even though the strict regex starts with
 * `[a-z]`. Constructors are always skipped (their name is the keyword
 * "constructor"), as are class getters/setters (the property name
 * casing is its own consideration).
 */

import { SymbolKind } from "@4d/core";
import type { LintFinding, LintRule } from "../../rule";
import { rangeForSymbol, safeRegex } from "../../util";

const APPLICABLE: Set<SymbolKind> = new Set([
  SymbolKind.ProjectMethod,
  SymbolKind.ClassFunction,
]);

interface Options {
  pattern: string;
  allowUnderscorePrefix: boolean;
}

const RULE: LintRule<Options> = {
  id: "style/method-camel-case",
  theme: "style",
  description: "Method / function names should match a configurable casing pattern.",
  defaultSeverity: "off",
  defaultOptions: {
    pattern: "^[a-z][A-Za-z0-9_]*$",
    allowUnderscorePrefix: true,
  },
  optionsSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", default: "^[a-z][A-Za-z0-9_]*$" },
      allowUnderscorePrefix: { type: "boolean", default: true },
    },
    additionalProperties: false,
  },
  check(ctx) {
    if (!ctx.parsed) return [];
    const re = safeRegex(ctx.options.pattern);
    if (!re) return [];
    const findings: LintFinding[] = [];
    for (const sym of ctx.parsed.symbols) {
      if (!APPLICABLE.has(sym.kind)) continue;
      const name = sym.name;
      if (ctx.options.allowUnderscorePrefix && name.startsWith("_")) {
        // Strip the underscore prefix; the rest still has to match.
        if (re.test(name.replace(/^_+/, ""))) continue;
      } else if (re.test(name)) {
        continue;
      }
      findings.push({
        range: rangeForSymbol(sym),
        message: `Name '${name}' does not match pattern '${ctx.options.pattern}'.`,
      });
    }
    return findings;
  },
};

export default RULE;
