/**
 * Smoke rule — flags lines that end with whitespace (excluding empty lines).
 *
 * Exists primarily to verify the lint framework end-to-end (registry →
 * runner → suppression → settings → publish) without depending on the
 * Phase A ParsedFile fields. The "real" linter rules land in Phase C.
 */

import type { LintRule, LintFinding } from "../../rule";

interface Options {
  /** Whether to treat tab characters in the trailing run as whitespace. */
  includeTabs: boolean;
}

const RULE: LintRule<Options> = {
  id: "style/trailing-whitespace",
  theme: "style",
  description: "Lines ending with trailing whitespace.",
  defaultSeverity: "off",
  defaultOptions: { includeTabs: true },
  optionsSchema: {
    type: "object",
    properties: {
      includeTabs: {
        type: "boolean",
        default: true,
        description: "Treat trailing tabs as whitespace.",
      },
    },
    additionalProperties: false,
  },
  check(ctx) {
    const findings: LintFinding[] = [];
    const trailing = ctx.options.includeTabs ? /([ \t]+)$/ : /( +)$/;
    const lines = ctx.source.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length === 0) continue;
      const m = trailing.exec(line);
      if (!m) continue;
      const start = line.length - m[1].length;
      findings.push({
        range: {
          start: { line: i, character: start },
          end: { line: i, character: line.length },
        },
        message: `Trailing whitespace (${m[1].length} character${m[1].length === 1 ? "" : "s"}).`,
      });
    }
    return findings;
  },
};

export default RULE;
