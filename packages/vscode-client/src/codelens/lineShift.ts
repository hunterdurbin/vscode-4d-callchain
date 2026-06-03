// Pure line-shift math for the dirty-line tracker. Kept free of any `vscode`
// import so it can be unit-tested under vitest (which has no `vscode` module).

/**
 * Shift a set of line markers in response to a single text edit.
 *
 * `lines` maps each function's saved (last-parsed) line to its *current* line
 * in the dirty buffer; this mutates the current-line values in place. Because
 * VS Code reports `contentChanges` in current-document coordinates (and
 * bottom-to-top within one event), and the map values are themselves current
 * coordinates, applying changes sequentially stays consistent.
 *
 * - A marker strictly below the changed region shifts by the net line delta.
 * - A marker at or above the change start is untouched.
 * - A marker inside the changed region stays anchored (edits typically land in
 *   the blank space between functions, so this case is rare; anchoring avoids a
 *   marker jumping when the text around it churns).
 *
 * @param startLine       zero-based first line of the replaced range
 * @param endLine         zero-based last line of the replaced range
 * @param addedLineCount  number of newlines in the inserted text
 */
export function applyContentChange(
  lines: Map<number, number>,
  startLine: number,
  endLine: number,
  addedLineCount: number
): void {
  const delta = addedLineCount - (endLine - startLine);
  if (delta === 0) return;
  for (const [saved, current] of lines) {
    if (current > endLine) {
      lines.set(saved, current + delta);
    }
  }
}

/** Count the newline characters in `text`. */
export function countNewlines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) n++;
  }
  return n;
}
