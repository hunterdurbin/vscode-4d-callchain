import {
  Connection,
  Position,
  Range,
  SelectionRange,
  SelectionRangeParams,
  TextDocuments
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { scanBlocks, Block } from "@4d/core";

/**
 * Build a smart Cmd+Shift+Right expansion chain for a single cursor position:
 *   word → paren-balanced expression → statement (line) → containing blocks
 *   (innermost first) → file.
 */
export function registerSelectionRangeHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>
): void {
  connection.onSelectionRanges((params: SelectionRangeParams): SelectionRange[] => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const text = doc.getText();
    const lines = text.split(/\r?\n/);
    const blocks = scanBlocks(text);
    return params.positions.map((pos) => buildChain(pos, lines, blocks));
  });
}

function buildChain(pos: Position, lines: string[], blocks: Block[]): SelectionRange {
  const ranges: Range[] = [];
  const line = lines[pos.line] ?? "";

  // 1. Word (identifier under cursor).
  const word = wordRange(line, pos);
  if (word) ranges.push(word);

  // 2. Balanced paren expression containing the cursor (deepest first, then
  //    expanding outward). Multiple nesting levels become individual ranges.
  for (const paren of parenRanges(line, pos)) ranges.push(paren);

  // 3. Whole line (statement).
  ranges.push(Range.create(
    Position.create(pos.line, 0),
    Position.create(pos.line, line.length)
  ));

  // 4. Containing blocks, innermost first.
  const containing = blocks
    .filter((b) => b.startLine <= pos.line && b.endLine >= pos.line)
    .sort((a, b) => (b.startLine - a.startLine) || (a.endLine - b.endLine));
  for (const b of containing) {
    ranges.push(Range.create(
      Position.create(b.startLine, 0),
      Position.create(b.endLine, (lines[b.endLine] ?? "").length)
    ));
  }

  // 5. File.
  const lastLine = Math.max(0, lines.length - 1);
  ranges.push(Range.create(
    Position.create(0, 0),
    Position.create(lastLine, (lines[lastLine] ?? "").length)
  ));

  // Deduplicate consecutive identical ranges and ensure each successive range
  // is a strict superset of the previous. Build the nested SelectionRange
  // chain from outermost inward.
  const cleaned: Range[] = [];
  for (const r of ranges) {
    if (cleaned.length === 0) { cleaned.push(r); continue; }
    const prev = cleaned[cleaned.length - 1];
    if (containsStrictly(r, prev)) cleaned.push(r);
  }
  let parent: SelectionRange | undefined;
  for (let i = cleaned.length - 1; i >= 0; i--) {
    parent = { range: cleaned[i], parent };
  }
  return parent ?? {
    range: Range.create(pos, pos),
    parent: undefined
  };
}

function wordRange(line: string, pos: Position): Range | undefined {
  const isWord = (c: string) => /[A-Za-z0-9_]/.test(c);
  let start = pos.character;
  let end = pos.character;
  while (start > 0 && isWord(line[start - 1])) start--;
  while (end < line.length && isWord(line[end])) end++;
  if (start === end) return undefined;
  return Range.create(Position.create(pos.line, start), Position.create(pos.line, end));
}

function parenRanges(line: string, pos: Position): Range[] {
  // Walk the line tracking paren depth; for every balanced pair that wraps
  // the cursor, emit the (start, end+1) range. Innermost first.
  const stack: number[] = [];
  const wrapping: Array<[number, number]> = [];
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "(") {
      stack.push(i);
    } else if (c === ")") {
      const open = stack.pop();
      if (open !== undefined && open < pos.character && i >= pos.character) {
        wrapping.push([open, i + 1]);
      }
    }
  }
  // Innermost wraps come last in `wrapping` (since we close them first); reverse.
  return wrapping.reverse().map(([s, e]) =>
    Range.create(Position.create(pos.line, s), Position.create(pos.line, e))
  );
}

function containsStrictly(outer: Range, inner: Range): boolean {
  const startBefore =
    outer.start.line < inner.start.line ||
    (outer.start.line === inner.start.line && outer.start.character <= inner.start.character);
  const endAfter =
    outer.end.line > inner.end.line ||
    (outer.end.line === inner.end.line && outer.end.character >= inner.end.character);
  if (!startBefore || !endAfter) return false;
  // Reject equal ranges so the chain strictly grows.
  const equal =
    outer.start.line === inner.start.line && outer.start.character === inner.start.character &&
    outer.end.line === inner.end.line && outer.end.character === inner.end.character;
  return !equal;
}
