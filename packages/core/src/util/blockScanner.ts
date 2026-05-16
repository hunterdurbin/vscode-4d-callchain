import { stripBlockComments, cleanLine } from "./textCleanup";

export type BlockKind =
  | "if"
  | "case"
  | "for"
  | "while"
  | "repeat"
  | "function"
  | "class";

export interface Block {
  kind: BlockKind;
  /** Zero-based line number where the block opens. */
  startLine: number;
  /** Zero-based line number where the block closes (inclusive). */
  endLine: number;
}

interface OpenBlock {
  kind: BlockKind;
  startLine: number;
}

// Anchored at the start of a cleaned line (leading whitespace already trimmed
// by the caller). Matches case-insensitively against 4D control-flow keywords.
const RE_IF        = /^if\s*\(/i;
const RE_ELSE      = /^else\b/i;          // Reserved for future Else folds.
const RE_END_IF    = /^end\s+if\b/i;
const RE_CASE      = /^case\s+of\b/i;
const RE_END_CASE  = /^end\s+case\b/i;
const RE_FOR       = /^for(\s+each)?\s*\(/i;
const RE_END_FOR   = /^end\s+for(\s+each)?\b/i;
const RE_WHILE     = /^while\s*\(/i;
const RE_END_WHILE = /^end\s+while\b/i;
const RE_REPEAT    = /^repeat\b/i;
const RE_UNTIL     = /^until\b/i;
const RE_FUNCTION  = /^(local\s+|shared\s+)?function\b/i;
const RE_CTOR      = /^class\s+constructor\b/i;

// A bare `End` line (no trailing keyword) closes whatever block is at the top
// of the stack — 4D's editor inserts the matching `End if` / `End for` / etc.
// automatically but legacy code may have just `End`.
const RE_END_BARE  = /^end\s*$/i;

void RE_ELSE; // Acknowledged: Else handling reserved for future fold-on-Else.

/**
 * Walk a 4D source string and emit the structural blocks worth folding. Uses
 * a single linear pass with a stack of open blocks. Lines are processed with
 * `cleanLine` so keywords inside comments/strings are ignored.
 *
 * Currently emitted block kinds:
 *   - if      (opens at `If (...)`,           closes at `End if`)
 *   - case    (opens at `Case of`,            closes at `End case`)
 *   - for     (opens at `For (...)` / `For each (...)`, closes at `End for` / `End for each`)
 *   - while   (opens at `While (...)`,        closes at `End while`)
 *   - repeat  (opens at `Repeat`,             closes at `Until ...`)
 *   - function (opens at `Function ...` or `Class constructor`, closes at
 *               the line BEFORE the next opener / EOF)
 *   - class    (file-level wrapper, opens at line 0, closes at EOF) — emitted
 *               only when the source contains a class function or constructor.
 */
export function scanBlocks(source: string): Block[] {
  const stripped = stripBlockComments(source);
  const lines = stripped.split(/\r?\n/);
  const blocks: Block[] = [];
  const stack: OpenBlock[] = [];

  let openFunction: { startLine: number } | undefined;
  let sawClassMember = false;

  const closeFunction = (atLine: number) => {
    if (!openFunction) return;
    // Functions close on the line BEFORE the next opener (so the next
    // function's header line isn't folded into the previous block).
    if (atLine - 1 > openFunction.startLine) {
      blocks.push({ kind: "function", startLine: openFunction.startLine, endLine: atLine - 1 });
    }
    openFunction = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const cleaned = cleanLine(lines[i]).text.trimStart();
    if (!cleaned) continue;

    // Function / Class constructor boundaries — these don't nest with control
    // flow but they DO close any previously-open function block.
    if (RE_FUNCTION.test(cleaned) || RE_CTOR.test(cleaned)) {
      sawClassMember = true;
      closeFunction(i);
      openFunction = { startLine: i };
      continue;
    }

    // Closers — popped before openers so a one-line `If ... End if` (rare) is
    // still well-formed.
    if (RE_END_IF.test(cleaned))    { popMatching(stack, "if", i, blocks); continue; }
    if (RE_END_CASE.test(cleaned))  { popMatching(stack, "case", i, blocks); continue; }
    if (RE_END_FOR.test(cleaned))   { popMatching(stack, "for", i, blocks); continue; }
    if (RE_END_WHILE.test(cleaned)) { popMatching(stack, "while", i, blocks); continue; }
    if (RE_UNTIL.test(cleaned))     { popMatching(stack, "repeat", i, blocks); continue; }
    if (RE_END_BARE.test(cleaned)) {
      // Bare `End` closes the innermost open block of any kind.
      const top = stack.pop();
      if (top && i > top.startLine) {
        blocks.push({ kind: top.kind, startLine: top.startLine, endLine: i });
      }
      continue;
    }

    // Openers
    if (RE_IF.test(cleaned))     { stack.push({ kind: "if", startLine: i }); continue; }
    if (RE_CASE.test(cleaned))   { stack.push({ kind: "case", startLine: i }); continue; }
    if (RE_FOR.test(cleaned))    { stack.push({ kind: "for", startLine: i }); continue; }
    if (RE_WHILE.test(cleaned))  { stack.push({ kind: "while", startLine: i }); continue; }
    if (RE_REPEAT.test(cleaned)) { stack.push({ kind: "repeat", startLine: i }); continue; }
  }

  // EOF — close any function still open and unwind unclosed blocks. Folding
  // tolerates dangling openers (legacy code that's syntactically suspect);
  // we still emit a fold from start to last line.
  if (openFunction && lines.length - 1 > openFunction.startLine) {
    blocks.push({ kind: "function", startLine: openFunction.startLine, endLine: lines.length - 1 });
  }
  while (stack.length > 0) {
    const top = stack.pop()!;
    if (lines.length - 1 > top.startLine) {
      blocks.push({ kind: top.kind, startLine: top.startLine, endLine: lines.length - 1 });
    }
  }

  // Class-file wrapper: makes the whole class foldable as a single region.
  if (sawClassMember && lines.length > 1) {
    blocks.push({ kind: "class", startLine: 0, endLine: lines.length - 1 });
  }

  return blocks;
}

function popMatching(stack: OpenBlock[], kind: BlockKind, atLine: number, out: Block[]): void {
  // Pop intervening unclosed inner blocks to recover gracefully — e.g. a
  // missing `End if` shouldn't swallow a subsequent `End case`.
  for (let p = stack.length - 1; p >= 0; p--) {
    if (stack[p].kind === kind) {
      // Discard anything above (assumed legacy/malformed); emit this one.
      const open = stack[p];
      stack.length = p;
      if (atLine > open.startLine) {
        out.push({ kind: open.kind, startLine: open.startLine, endLine: atLine });
      }
      return;
    }
  }
  // No matching opener — silently drop the closer.
}
