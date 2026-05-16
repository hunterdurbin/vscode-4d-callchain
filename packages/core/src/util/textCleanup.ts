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
 * (so callers like CALL WORKER can recover the original method name) and a
 * `cols` array that maps each output character back to its position in
 * `input` (length is text.length + 1 so exclusive end positions translate too).
 */
export function cleanLine(input: string): { text: string; strings: string[]; cols: number[] } {
  const strings: string[] = [];
  let out = "";
  const cols: number[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "/" && input[i + 1] === "/") {
      break;
    }
    if (ch === "/" && input[i + 1] === "*") {
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
      const placeholder = `"${strings.length - 1}"`;
      // Map placeholder chars back to the original string range so callers
      // recovering identifier columns can land within the literal:
      //   opening "  → input pos of opening quote (i)
      //   digit(s)   → input pos just inside the string (i+1)
      //   closing "  → input pos of closing quote (j)
      cols.push(i);
      for (let p = 1; p < placeholder.length - 1; p++) cols.push(i + 1);
      cols.push(j);
      out += placeholder;
      i = j + 1;
      continue;
    }
    cols.push(i);
    out += ch;
    i++;
  }
  cols.push(i);
  return { text: out, strings, cols };
}

/**
 * Recover a quoted string by sentinel index from cleanLine output.
 */
export function recoverString(text: string, strings: string[], match: string): string | null {
  const m = match.match(/(\d+)/);
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
