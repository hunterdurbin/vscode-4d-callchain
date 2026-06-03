/**
 * Lint rule contract.
 *
 * Each rule lives in `lint/rules/<theme>/<id>.ts` and exports a single
 * `LintRule`. The runner (`lint/runner.ts`) iterates the registry, runs
 * the rules that the user has enabled, and emits `Diagnostic[]` on top of
 * the existing `unresolved-call` diagnostic from `handlers/diagnostics.ts`.
 *
 * Rules ship `defaultSeverity: "off"` — they're opt-in via the
 * `callchain.lint.rules.{id}` VSCode setting (severity string or
 * `{ severity, options }` object). The user can override any rule's
 * options without touching code.
 */

import type { CallGraph, ParsedFile } from "@4d/core";
import type { Diagnostic, DiagnosticSeverity } from "vscode-languageserver/node";

export type Severity = "off" | "info" | "warning" | "error";

/** Source value as it appears in `callchain.lint.rules.{id}`. */
export type RuleSettingValue = Severity | { severity?: Severity; options?: unknown };

/** Map<ruleId, RuleSettingValue> — the full `callchain.lint.rules` blob. */
export type LintConfig = Record<string, RuleSettingValue>;

export interface LintFinding {
  /** Zero-based line/character range — same shape as LSP `Range`. */
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
}

export interface LintContext<TOptions> {
  /** URI of the file under analysis (`file://…`). */
  uri: string;
  /** Live source text (from `TextDocuments` for open files, disk otherwise). */
  source: string;
  /** Pre-parsed file from `Indexer.getParsedFile()` — undefined when the
   *  index was cold-loaded from cache or the file isn't `.4dm`. Rules that
   *  need it should skip when undefined rather than throw. */
  parsed: ParsedFile | undefined;
  /** Call graph — always available once `Indexer.load()` resolves. Rules
   *  use this for cross-symbol queries like "no callers". */
  callGraph: CallGraph | undefined;
  /** Merged user options over `defaultOptions`. Always a value (never undefined). */
  options: TOptions;
}

export interface LintRule<TOptions = unknown> {
  id: string;
  theme: "unused" | "types" | "style" | "decl";
  description: string;
  /** All rules ship off-by-default. The user explicitly opts in via settings. */
  defaultSeverity: "off";
  /** Baked-in safe defaults. Merged with the user's `options` blob; missing
   *  keys fall back to these. */
  defaultOptions: TOptions;
  /** Lightweight JSONSchema for the rule's `options` blob. Surfaced in the
   *  `package.json` contributes block so VSCode's Settings UI can hint at
   *  shape. Not used to enforce runtime correctness — the rule body must
   *  still be defensive about its option types. */
  optionsSchema: unknown;
  check(ctx: LintContext<TOptions>): LintFinding[];
}

/** Convert our rule-config Severity to LSP `DiagnosticSeverity`. */
export function severityToLsp(severity: Severity): DiagnosticSeverity | undefined {
  switch (severity) {
    case "error":
      return 1 satisfies DiagnosticSeverity;
    case "warning":
      return 2 satisfies DiagnosticSeverity;
    case "info":
      return 3 satisfies DiagnosticSeverity;
    case "off":
      return undefined;
  }
}

/** Result of `Registry.resolveSetting()` — normalized severity + options. */
export interface ResolvedRuleConfig<TOptions> {
  severity: Severity;
  options: TOptions;
}

export type DiagnosticOut = Diagnostic;
