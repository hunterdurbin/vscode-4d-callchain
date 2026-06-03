/**
 * style/builtin-name-collision — flag user-defined symbols whose name
 * collides (case-insensitive) with a 4D built-in command. 4D is
 * case-insensitive for command lookup, so a project method named
 * `length` is treated identically to the built-in `Length`, which makes
 * the call graph ambiguous and produces brittle behavior in legacy
 * code.
 *
 * Checks ProjectMethod, ClassFunction, ClassGetter, and ClassSetter
 * symbols. `ignoreNames` lets the user allow specific collisions
 * (project owns the meaning).
 */

import { BUILTIN_SET, SymbolKind } from "@4d/core";
import type { LintFinding, LintRule } from "../../rule";
import { rangeForSymbol } from "../../util";

const APPLICABLE: Set<SymbolKind> = new Set([
  SymbolKind.ProjectMethod,
  SymbolKind.ClassFunction,
  SymbolKind.ClassGetter,
  SymbolKind.ClassSetter,
]);

interface Options {
  ignoreNames: string[];
}

// Build a lowercase mirror of BUILTIN_SET once at module load — the
// upstream set is mixed-case (e.g. "Length", "On Startup") and the rule
// needs case-insensitive lookups.
const LOWERCASE_BUILTINS = new Set<string>();
for (const name of BUILTIN_SET) LOWERCASE_BUILTINS.add(name.toLowerCase());

const RULE: LintRule<Options> = {
  id: "style/builtin-name-collision",
  theme: "style",
  description:
    "User symbols whose name (case-insensitive) collides with a 4D built-in command.",
  defaultSeverity: "off",
  defaultOptions: { ignoreNames: [] },
  optionsSchema: {
    type: "object",
    properties: {
      ignoreNames: {
        type: "array",
        items: { type: "string" },
        default: [],
        description: "Names to skip even if they collide (case-sensitive match).",
      },
    },
    additionalProperties: false,
  },
  check(ctx) {
    if (!ctx.parsed) return [];
    const ignore = new Set(ctx.options.ignoreNames ?? []);
    const findings: LintFinding[] = [];
    for (const sym of ctx.parsed.symbols) {
      if (!APPLICABLE.has(sym.kind)) continue;
      if (ignore.has(sym.name)) continue;
      if (!LOWERCASE_BUILTINS.has(sym.name.toLowerCase())) continue;
      findings.push({
        range: rangeForSymbol(sym),
        message: `Name '${sym.name}' collides with a 4D built-in command (case-insensitive).`,
      });
    }
    return findings;
  },
};

export default RULE;
