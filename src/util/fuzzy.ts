/**
 * Chars-in-order, case-insensitive fuzzy match (the same logic VS Code's
 * command palette uses). `calcrec` matches `IQ_CalculateRecord` because
 * c, a, l, c, r, e, c all appear in that order somewhere in the target.
 */
export function fuzzyMatch(query: string, target: string): boolean {
  if (!query) return true;
  if (!target) return false;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t.charCodeAt(ti) === q.charCodeAt(qi)) qi++;
  }
  return qi === q.length;
}

export interface ParsedQuery {
  /** Positive fuzzy text (after stripping operators and excludes). */
  fuzzy: string;
  /** Tokens prefixed with `-` — each excludes symbols whose name fuzzy-matches it. */
  excludes: string[];
  /** Numeric predicate on caller count parsed from `>N`/`<N`/`=N`/`>=N`/`<=N`. */
  callerPredicate?: (n: number) => boolean;
  /** Human-readable form of the caller predicate, e.g. `">5"`. */
  callerDesc?: string;
}

/**
 * Parse a filter string into structured parts:
 *   - leading `-` on a token → exclude (e.g. `-test`)
 *   - `>N` / `<N` / `=N` / `>=N` / `<=N` → caller-count predicate
 *   - everything else joins into a positive fuzzy query
 *
 * `braintree -test >5` → fuzzy="braintree", excludes=["test"], callers>5.
 */
export function parseFilterQuery(raw: string): ParsedQuery {
  if (!raw) return { fuzzy: "", excludes: [] };
  const tokens = raw.split(/\s+/).filter(Boolean);
  const positives: string[] = [];
  const excludes: string[] = [];
  let callerPredicate: ((n: number) => boolean) | undefined;
  let callerDesc: string | undefined;
  for (const t of tokens) {
    const cmp = t.match(/^(>=|<=|>|<|=)(\d+)$/);
    if (cmp) {
      const op = cmp[1];
      const n = parseInt(cmp[2], 10);
      callerDesc = `${op}${n}`;
      switch (op) {
        case ">":  callerPredicate = (x) => x > n; break;
        case "<":  callerPredicate = (x) => x < n; break;
        case ">=": callerPredicate = (x) => x >= n; break;
        case "<=": callerPredicate = (x) => x <= n; break;
        case "=":  callerPredicate = (x) => x === n; break;
      }
      continue;
    }
    if (t.startsWith("-") && t.length > 1) {
      excludes.push(t.slice(1));
      continue;
    }
    positives.push(t);
  }
  return {
    fuzzy: positives.join(" "),
    excludes,
    callerPredicate,
    callerDesc
  };
}
