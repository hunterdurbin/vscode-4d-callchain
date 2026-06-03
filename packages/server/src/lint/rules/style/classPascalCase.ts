/**
 * style/class-pascal-case — flag class names that don't match the
 * project's preferred casing. Default is strict PascalCase
 * (`^[A-Z][A-Za-z0-9]*$`); override `pattern` for project conventions.
 *
 * 4D ships built-in classes (`Entity`, `Collection`, `Cs.…`) so this rule
 * targets user-defined `Class` symbols — the visitor emits exactly one
 * `SymbolKind.Class` per `.4dm` class file, so each project class is
 * checked once.
 */

import { SymbolKind } from "@4d/core";
import type { LintFinding, LintRule } from "../../rule";
import { rangeForSymbol, safeRegex } from "../../util";

interface Options {
  pattern: string;
}

const RULE: LintRule<Options> = {
  id: "style/class-pascal-case",
  theme: "style",
  description: "Class names should match a configurable casing pattern.",
  defaultSeverity: "off",
  defaultOptions: { pattern: "^[A-Z][A-Za-z0-9]*$" },
  optionsSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        default: "^[A-Z][A-Za-z0-9]*$",
        description: "Regex the class name must match.",
      },
    },
    additionalProperties: false,
  },
  check(ctx) {
    if (!ctx.parsed) return [];
    const re = safeRegex(ctx.options.pattern);
    if (!re) return [];
    const findings: LintFinding[] = [];
    for (const sym of ctx.parsed.symbols) {
      if (sym.kind !== SymbolKind.Class) continue;
      if (re.test(sym.name)) continue;
      findings.push({
        range: rangeForSymbol(sym),
        message: `Class name '${sym.name}' does not match pattern '${ctx.options.pattern}'.`,
      });
    }
    return findings;
  },
};

export default RULE;
