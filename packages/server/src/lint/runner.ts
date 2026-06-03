/**
 * Lint runner — top of the lint pipeline.
 *
 * Called from the existing diagnostic publisher (`handlers/diagnostics.ts`).
 * Given a file's URI, source text, parsed file, and the current
 * `callchain.lint.rules` config, runs every enabled rule and returns a
 * single `Diagnostic[]`. Inline suppression is applied as a final filter
 * before the diagnostic list leaves the runner.
 *
 * Diagnostics use `source: "4d-lint"` so they're distinguishable from the
 * unresolved-call ones (`source: "4d"`) that already live in the Problems
 * panel.
 */

import type { CallGraph, ParsedFile } from "@4d/core";
import type { Diagnostic } from "vscode-languageserver/node";

import { allRules, resolveSetting } from "./registry";
import type { LintConfig, LintRule } from "./rule";
import { severityToLsp } from "./rule";
import { parseSuppressions } from "./suppression";

export const LINT_DIAGNOSTIC_SOURCE = "4d-lint";

export interface RunRulesInput {
  uri: string;
  source: string;
  parsed: ParsedFile | undefined;
  callGraph: CallGraph | undefined;
  config: LintConfig;
}

/**
 * Hard cap on lint diagnostics per file. Matches the existing
 * `MAX_PER_FILE` cap on unresolved-call warnings — the Problems panel
 * stays usable on legacy files even when several noisy rules are on.
 */
const MAX_FINDINGS_PER_FILE = 100;

export function runRules(input: RunRulesInput): Diagnostic[] {
  const out: Diagnostic[] = [];
  const suppressions = parseSuppressions(input.source);

  for (const rule of allRules()) {
    if (out.length >= MAX_FINDINGS_PER_FILE) break;
    const setting = input.config[rule.id];
    if (setting === undefined) continue;
    const { severity, options } = resolveSetting<unknown>(
      rule as LintRule<unknown>,
      setting,
    );
    if (severity === "off") continue;
    const lspSeverity = severityToLsp(severity);
    if (lspSeverity === undefined) continue;

    let findings;
    try {
      findings = rule.check({
        uri: input.uri,
        source: input.source,
        parsed: input.parsed,
        callGraph: input.callGraph,
        options,
      });
    } catch (err) {
      // A buggy rule must NEVER take down diagnostic publishing — emit a
      // single info diagnostic on line 0 so the user knows the rule
      // crashed, then continue with the rest of the rules.
      out.push({
        severity: 3, // Information
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        source: LINT_DIAGNOSTIC_SOURCE,
        code: `${rule.id} (crashed)`,
        message: `Lint rule '${rule.id}' threw: ${(err as Error).message}`,
      });
      continue;
    }

    for (const finding of findings) {
      if (out.length >= MAX_FINDINGS_PER_FILE) break;
      if (suppressions.isSuppressed(rule.id, finding.range.start.line)) continue;
      out.push({
        severity: lspSeverity,
        range: finding.range,
        source: LINT_DIAGNOSTIC_SOURCE,
        code: rule.id,
        message: finding.message,
      });
    }
  }

  return out;
}
