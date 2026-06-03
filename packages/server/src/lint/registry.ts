/**
 * Registry of built-in lint rules.
 *
 * The runner consults this registry once per `publishForFile()` call. New
 * rules in Phase C are added here — no other plumbing is required as long
 * as the rule conforms to the `LintRule` contract.
 *
 * `resolveSetting()` normalizes a user-provided severity-string-or-object
 * into `{ severity, options }` with defaults filled in. Lives next to the
 * registry because the merging logic depends on the rule's `defaultOptions`.
 */

import type {
  LintConfig,
  LintRule,
  ResolvedRuleConfig,
  RuleSettingValue,
  Severity,
} from "./rule";

import trailingWhitespace from "./rules/style/trailingWhitespace";
import missingParamType from "./rules/types/missingParamType";
import missingReturnType from "./rules/types/missingReturnType";
import implicitLocal from "./rules/decl/implicitLocal";
import methodNoCallers from "./rules/unused/methodNoCallers";
import unusedParameter from "./rules/unused/parameter";
import unusedLocal from "./rules/unused/local";
import classPascalCase from "./rules/style/classPascalCase";
import methodCamelCase from "./rules/style/methodCamelCase";
import missingDocstring from "./rules/style/missingDocstring";
import builtinNameCollision from "./rules/style/builtinNameCollision";

const SEVERITY_VALUES: Set<Severity> = new Set(["off", "info", "warning", "error"]);

/** All built-in rules, in stable order. */
const RULES: LintRule<any>[] = [
  trailingWhitespace,
  missingParamType,
  missingReturnType,
  implicitLocal,
  methodNoCallers,
  unusedParameter,
  unusedLocal,
  classPascalCase,
  methodCamelCase,
  missingDocstring,
  builtinNameCollision,
];

const BY_ID = new Map(RULES.map((r) => [r.id, r] as const));

export function getRule(id: string): LintRule | undefined {
  return BY_ID.get(id);
}

export function allRules(): readonly LintRule[] {
  return RULES;
}

/**
 * Returns rules with a non-`"off"` resolved severity in the given config.
 * The runner then invokes each rule's `check()` and stamps the diagnostic
 * with this severity. Rules absent from config (or set to `"off"`) are
 * skipped.
 */
export function getEnabledRules(config: LintConfig): LintRule[] {
  const out: LintRule[] = [];
  for (const rule of RULES) {
    const setting = config[rule.id];
    if (setting === undefined) continue;
    const resolved = resolveSetting(rule, setting);
    if (resolved.severity === "off") continue;
    out.push(rule);
  }
  return out;
}

/**
 * Normalize a user-provided setting value (string OR object) into a fully
 * resolved `{ severity, options }`. Invalid severities fall back to
 * `defaultSeverity` (which is `"off"` for every built-in rule, so an
 * invalid setting is equivalent to disabling). Missing options keys fall
 * back to `defaultOptions`.
 *
 * Defensive about untyped JSON: never throws on malformed input.
 */
export function resolveSetting<TOptions>(
  rule: LintRule<TOptions>,
  value: RuleSettingValue,
): ResolvedRuleConfig<TOptions> {
  if (typeof value === "string") {
    return {
      severity: SEVERITY_VALUES.has(value) ? value : rule.defaultSeverity,
      options: rule.defaultOptions,
    };
  }
  if (value && typeof value === "object") {
    const rawSev = (value as { severity?: unknown }).severity;
    const severity: Severity =
      typeof rawSev === "string" && SEVERITY_VALUES.has(rawSev as Severity)
        ? (rawSev as Severity)
        : rule.defaultSeverity;
    const rawOpts = (value as { options?: unknown }).options;
    const options =
      rawOpts && typeof rawOpts === "object"
        ? ({ ...(rule.defaultOptions as object), ...(rawOpts as object) } as TOptions)
        : rule.defaultOptions;
    return { severity, options };
  }
  // Anything else — boolean, number, null — counts as a noop disable.
  return { severity: rule.defaultSeverity, options: rule.defaultOptions };
}
