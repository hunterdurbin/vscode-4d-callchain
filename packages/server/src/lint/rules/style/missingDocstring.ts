/**
 * style/missing-docstring-on-public — flag "public" methods whose
 * declaration is not preceded by a comment block.
 *
 * Walks backward from `bodySpan.startLine - 1` collecting contiguous
 * comment lines (`//`, backtick, or block-comment style) and stops at
 * the first non-blank, non-comment line. A symbol passes when at least
 * `minLines` comment lines are found.
 *
 * "Public" defaults to project methods + class functions whose name does
 * not start with `_`. Override via `publicPattern`.
 *
 * Class constructors / getters / setters are skipped — their
 * documentation belongs on the class or property, not on each accessor.
 */

import { SymbolKind } from "@4d/core";
import type { LintFinding, LintRule } from "../../rule";
import { rangeForSymbol, safeRegex } from "../../util";

const APPLICABLE: Set<SymbolKind> = new Set([
  SymbolKind.ProjectMethod,
  SymbolKind.ClassFunction,
]);

interface Options {
  publicPattern: string;
  minLines: number;
  acceptedPrefixes: string[];
}

const RULE: LintRule<Options> = {
  id: "style/missing-docstring-on-public",
  theme: "style",
  description:
    "Public project methods / class functions missing a leading docstring comment.",
  defaultSeverity: "off",
  defaultOptions: {
    publicPattern: "^[^_]",
    minLines: 1,
    acceptedPrefixes: ["//", "`", "/*"],
  },
  optionsSchema: {
    type: "object",
    properties: {
      publicPattern: { type: "string", default: "^[^_]" },
      minLines: { type: "number", default: 1, minimum: 1 },
      acceptedPrefixes: {
        type: "array",
        items: { type: "string" },
        default: ["//", "`", "/*"],
      },
    },
    additionalProperties: false,
  },
  check(ctx) {
    if (!ctx.parsed) return [];
    const publicRe = safeRegex(ctx.options.publicPattern);
    const prefixes = ctx.options.acceptedPrefixes ?? [];
    const minLines = Math.max(1, ctx.options.minLines | 0);
    if (prefixes.length === 0) return [];
    const lines = ctx.source.split(/\r?\n/);
    const findings: LintFinding[] = [];

    for (const sym of ctx.parsed.symbols) {
      if (!APPLICABLE.has(sym.kind)) continue;
      if (publicRe && !publicRe.test(sym.name)) continue;
      // We need a body span to know where to scan from. For ProjectMethod
      // the visitor sets it to `{startLine: 0, endLine: fileEndLine}` —
      // which would scan backwards from -1, finding nothing. Skip those.
      const span = sym.bodySpan;
      if (!span || span.startLine <= 0) continue;
      let collected = 0;
      for (let i = span.startLine - 1; i >= 0; i--) {
        const line = lines[i] ?? "";
        const trimmed = line.trim();
        if (trimmed === "") {
          // Blank line breaks the leading-comment block.
          break;
        }
        const isComment = prefixes.some((p) => trimmed.startsWith(p));
        if (!isComment) break;
        collected++;
        if (collected >= minLines) break;
      }
      if (collected < minLines) {
        findings.push({
          range: rangeForSymbol(sym),
          message:
            sym.kind === SymbolKind.ClassFunction
              ? `Class function '${sym.name}' is missing a leading docstring comment.`
              : `Project method '${sym.name}' is missing a leading docstring comment.`,
        });
      }
    }
    return findings;
  },
};

export default RULE;
