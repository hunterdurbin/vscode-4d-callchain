/**
 * Inline lint suppression.
 *
 * Comments in 4D start with `//`, `` ` `` (v18+), or `/* … *\/` (block).
 * The tree-sitter grammar treats them as `extras` and strips them before
 * the CST is exposed, so suppression is parsed out of the raw source
 * here in the language server.
 *
 * Supported forms (case-sensitive directive, ids comma- or
 * space-separated; `*` disables every rule):
 *
 *   // lint-disable-next-line <id> [, <id> ...]
 *   // lint-disable-line       <id> [, <id> ...]
 *   // lint-disable            <id> [, <id> ...]    (file-scoped if at top)
 *
 * Backtick and block comment variants are accepted in the same shape:
 *
 *   ` lint-disable-next-line <id>
 *   /* lint-disable-line <id> *\/
 *
 * `lint-disable` without a line modifier counts as file-scoped only when
 * it appears in a leading-comment block at the top of the file (line
 * index < `FILE_SCOPED_LEAD_LINES`). Otherwise it's ignored — we don't
 * support block-scoped disable in v1 (see plan §Non-Goals).
 */

const FILE_SCOPED_LEAD_LINES = 20;

interface Suppression {
  /** Specific line (zero-based) the suppression applies to, or "file" for
   *  file-wide. */
  scope: number | "file";
  /** Rule ids the suppression disables, or "*" for all rules. */
  ids: string[];
}

export interface SuppressionMap {
  /** True when `ruleId` is suppressed on `line`. */
  isSuppressed(ruleId: string, line: number): boolean;
}

const DIRECTIVE_RE =
  /\b(lint-disable-next-line|lint-disable-line|lint-disable)\b([^*\n\r`]*)/;

export function parseSuppressions(source: string): SuppressionMap {
  const lines = source.split(/\r?\n/);
  const perLine = new Map<number, Set<string>>(); // line → suppressed ids
  const fileWide = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const directive = extractDirective(line);
    if (!directive) continue;
    const { kind, ids } = directive;
    if (kind === "next-line") {
      addAll(perLine, i + 1, ids);
    } else if (kind === "line") {
      addAll(perLine, i, ids);
    } else {
      // `lint-disable` — file-scoped only when it's in the leading-comment
      // block. Anything later is silently ignored (we don't support
      // block-scoped disable in v1).
      if (i < FILE_SCOPED_LEAD_LINES) {
        for (const id of ids) fileWide.add(id);
      }
    }
  }

  return {
    isSuppressed(ruleId: string, line: number): boolean {
      if (fileWide.has("*") || fileWide.has(ruleId)) return true;
      const set = perLine.get(line);
      if (!set) return false;
      return set.has("*") || set.has(ruleId);
    },
  };
}

interface Directive {
  kind: "next-line" | "line" | "file";
  ids: string[];
}

/**
 * Pull a `lint-disable-*` directive out of a single line. Returns
 * undefined if the line doesn't carry one. We only accept the directive
 * when it sits inside a comment — guarding by checking the comment-prefix
 * substring (`//`, `` ` ``, `/*`) appears before the directive text.
 */
function extractDirective(line: string): Directive | undefined {
  const m = DIRECTIVE_RE.exec(line);
  if (!m) return undefined;
  const directiveStart = m.index;
  const before = line.slice(0, directiveStart);
  if (
    !before.includes("//") &&
    !before.includes("`") &&
    !before.includes("/*")
  ) {
    return undefined;
  }
  const tail = m[2];
  const ids = tail
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return undefined;
  const kind =
    m[1] === "lint-disable-next-line"
      ? "next-line"
      : m[1] === "lint-disable-line"
      ? "line"
      : "file";
  return { kind, ids };
}

function addAll(map: Map<number, Set<string>>, line: number, ids: string[]): void {
  let set = map.get(line);
  if (!set) {
    set = new Set();
    map.set(line, set);
  }
  for (const id of ids) set.add(id);
}
