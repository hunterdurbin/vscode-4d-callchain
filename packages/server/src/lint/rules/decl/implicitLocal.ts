/**
 * decl/implicit-local — flag local variables whose first appearance is an
 * assignment with no preceding `var`, `C_*`, or `#DECLARE` declaration.
 * Implicit locals work in interpreted mode but break under compilation
 * (Designer's COMPILER complains about every undeclared `$var`).
 *
 * Powered by `ParsedFile.localDeclMode` (Phase A): "declared" wins over
 * "implicit" in any order, so reordering `var $x` to the bottom of the
 * function still satisfies the rule. The first write site (from
 * `localWrites`) is used for the diagnostic range.
 *
 * Default ignores names matching `^_` so intentional throwaways like
 * `$_unused := computeButIgnore()` don't fire.
 */

import type { LintFinding, LintRule } from "../../rule";
import { rangeForUsage, safeRegex } from "../../util";

interface Options {
  /** Names matching this regex are not flagged. Use to exempt
   *  intentional placeholders or generated locals. */
  ignoreNamePattern: string;
}

const RULE: LintRule<Options> = {
  id: "decl/implicit-local",
  theme: "decl",
  description:
    "Local variables assigned without a prior `var` / `#DECLARE` / `C_*` declaration.",
  defaultSeverity: "off",
  defaultOptions: { ignoreNamePattern: "^_" },
  optionsSchema: {
    type: "object",
    properties: {
      ignoreNamePattern: {
        type: "string",
        default: "^_",
        description:
          "Names matching this regex are skipped (no `$` prefix). Default is `^_` for placeholder convention.",
      },
    },
    additionalProperties: false,
  },
  check(ctx) {
    if (!ctx.parsed) return [];
    const ignore = safeRegex(ctx.options.ignoreNamePattern);
    const findings: LintFinding[] = [];
    for (const [symbolId, modeMap] of ctx.parsed.localDeclMode) {
      const writes = ctx.parsed.localWrites.get(symbolId);
      if (!writes) continue;
      for (const [name, mode] of modeMap) {
        if (mode !== "implicit") continue;
        if (ignore && ignore.test(name)) continue;
        const sites = writes.get(name);
        if (!sites || sites.length === 0) continue;
        // Squiggle the first write — that's the de-facto declaration site
        // the user would convert to `var $x : T` to fix this.
        findings.push({
          range: rangeForUsage(sites[0]),
          message: `Local variable '$${name}' is used without a prior 'var', 'C_*', or '#DECLARE' declaration.`,
        });
      }
    }
    return findings;
  },
};

export default RULE;
