/**
 * Strip 4D comments and string literals from a line, replacing strings with
 * sentinel "STR" tokens so call extractors don't match patterns inside strings.
 *
 * 4D supports:
 *   // single-line comments
 *   /* block comments *\/
 *   "double-quoted strings" with escaped quotes via doubling
 *
 * Returns the sanitized text plus the list of string literals removed
 * (so callers like CALL WORKER can recover the original method name).
 */
export function cleanLine(input: string): { text: string; strings: string[] } {
  const strings: string[] = [];
  let out = "";
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "/" && input[i + 1] === "/") {
      // Rest is comment
      break;
    }
    if (ch === "/" && input[i + 1] === "*") {
      // Skip to end of block comment on this line; if it doesn't end, stop
      const end = input.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let lit = "";
      while (j < input.length) {
        if (input[j] === '"' && input[j + 1] === '"') {
          lit += '"';
          j += 2;
          continue;
        }
        if (input[j] === '"') break;
        lit += input[j];
        j++;
      }
      strings.push(lit);
      out += `"${strings.length - 1}"`;
      i = j + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out, strings };
}

/**
 * Recover a quoted string by sentinel index from cleanLine output.
 */
export function recoverString(text: string, strings: string[], match: string): string | null {
  const m = match.match(/(\d+)/);
  if (!m) return null;
  const idx = Number(m[1]);
  return strings[idx] ?? null;
}

/**
 * Strip block comments that span multiple lines from a whole-file source.
 */
export function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}
