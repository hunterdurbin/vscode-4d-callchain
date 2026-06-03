/**
 * unused/local — flag local variables that are written but never read.
 * Uses Phase A's `localWrites` + `localReads`: a name in writes but not
 * in reads is dead.
 *
 * Params are NOT flagged here — they're not in `localWrites` (they have
 * no assignment site). For unused parameters see `unused/parameter`.
 *
 * Default ignores names matching `^_` so intentional throwaways like
 * `$_ := computeForSideEffect()` don't fire.
 */

import type { LintFinding, LintRule } from "../../rule";
import { rangeForUsage, safeRegex } from "../../util";

interface Options {
  ignoreNamePattern: string;
}

const RULE: LintRule<Options> = {
  id: "unused/local",
  theme: "unused",
  description:
    "Local variables that are assigned (or declared via var / C_*) but never read.",
  defaultSeverity: "off",
  defaultOptions: { ignoreNamePattern: "^_" },
  optionsSchema: {
    type: "object",
    properties: {
      ignoreNamePattern: {
        type: "string",
        default: "^_",
        description:
          "Local names matching this regex are skipped (no `$` prefix).",
      },
    },
    additionalProperties: false,
  },
  check(ctx) {
    if (!ctx.parsed) return [];
    const ignore = safeRegex(ctx.options.ignoreNamePattern);
    const findings: LintFinding[] = [];
    for (const [symbolId, writes] of ctx.parsed.localWrites) {
      const reads = ctx.parsed.localReads.get(symbolId);
      for (const [name, sites] of writes) {
        if (ignore && ignore.test(name)) continue;
        if (reads && reads.has(name)) continue;
        if (sites.length === 0) continue;
        findings.push({
          range: rangeForUsage(sites[0]),
          message: `Local variable '$${name}' is assigned but never read.`,
        });
      }
    }
    return findings;
  },
};

export default RULE;
