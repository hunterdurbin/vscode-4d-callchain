/**
 * 4D lexer for LSP semantic-tokens highlighting.
 *
 * Produces a flat list of lexical tokens for a whole file. Each token is
 * line-bounded — multi-line constructs (block comments, multi-line strings if
 * any) are split into per-line tokens so the LSP encoded-delta format can carry
 * them.
 *
 * Identifier tokens are emitted as `identifier` but the consumer (semantic
 * tokens handler) drops them: the symbol-aware pass already colors identifiers
 * with higher fidelity (function vs. method vs. class vs. builtin).
 */

export type LexTokenKind =
  | "keyword"
  | "string"
  | "number"
  | "comment"
  | "localVar"
  | "parameter"
  | "interprocessVar"
  | "processVar"
  | "tableRef"
  | "fieldRef"
  | "type"
  | "builtinGlobal"
  | "property"
  | "operator"
  | "identifier";

export interface TokenizeOptions {
  /** Lowercased names of declared process / interprocess variables. Matched
   *  case-insensitively against bare identifiers. When omitted, no
   *  `processVar` tokens are emitted. */
  processVariables?: Set<string>;
}

export interface LexToken {
  /** 0-based line index. */
  line: number;
  /** 0-based UTF-16 offset within the line. */
  startChar: number;
  length: number;
  kind: LexTokenKind;
}

// Multi-word keywords, longest first. Matched case-insensitively. Whitespace
// runs between words may be one or more spaces/tabs.
const MULTI_WORD_KEYWORDS: string[] = [
  "End SQL Without",
  "Class constructor",
  "Class extends",
  "End for each",
  "For each",
  "Else if",
  "End if",
  "End for",
  "End while",
  "End case",
  "End class",
  "End function",
  "End use",
  "Case of",
  "Begin SQL",
  "End SQL"
];

// Pre-split into word arrays for fast matching.
const MULTI_WORD_PARTS: string[][] = MULTI_WORD_KEYWORDS.map((kw) =>
  kw.split(/\s+/).map((w) => w.toLowerCase())
);

const SINGLE_WORD_KEYWORDS = new Set<string>([
  "if",
  "else",
  "end",
  "for",
  "while",
  "repeat",
  "until",
  "case",
  "function",
  "class",
  "try",
  "catch",
  "throw",
  "return",
  "true",
  "false",
  "null",
  "this",
  "super",
  "var",
  "local",
  "shared",
  "begin",
  "use",
  "new",
  "extends"
]);

// Top-level global identifiers that 4D treats as builtin "commands":
//   cs       — class store
//   ds       — datastore
//   Storage  — process-shared storage
//   Form     — current-form object
// Per the official VS Code extension, these tokenize as method.defaultLibrary
// even when written as bare identifiers (e.g. before a `.` member access).
const BUILTIN_GLOBALS = new Set<string>(["cs", "ds", "storage", "form"]);

// Directives like `#DECLARE`, `#PROJECT METHOD`, `#PROPERTIES`. Match
// case-insensitively, leading `#` then an identifier-shape body (possibly with
// spaces for multi-word directives like `#PROJECT METHOD`).
const DIRECTIVE_NAMES = new Set<string>([
  "declare",
  "project method",
  "properties"
]);

const isWordChar = (c: string): boolean =>
  (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "_";
const isLetterOrUnderscore = (c: string): boolean =>
  (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_";
const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isHexDigit = (c: string): boolean =>
  isDigit(c) || (c >= "A" && c <= "F") || (c >= "a" && c <= "f");
const isSpaceOrTab = (c: string): boolean => c === " " || c === "\t";

export function tokenize(source: string, options?: TokenizeOptions): LexToken[] {
  const out: LexToken[] = [];
  const lines = source.split(/\r?\n/);
  const processVariables = options?.processVariables;

  let inBlockComment = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    let i = 0;
    // Coloring state for the next identifier:
    //   expectingType     — set by `:` (not `:=`); the next bare identifier is
    //                       a 4D type (e.g. `Object`, `Text`, or a class name).
    //   expectingProperty — set by `.`; the next identifier is a member access
    //                       and tokenizes as `property` (matches the official
    //                       4D convention: `cs.IQ_Options` → builtinGlobal +
    //                       operator + property, not type + type).
    // Both reset at line boundaries and whenever a non-preserving char (any
    // operator/punctuation other than `.` or `:`) is consumed.
    let expectingType = false;
    let expectingProperty = false;

    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end === -1) {
        if (line.length > 0) {
          out.push({ line: lineIdx, startChar: 0, length: line.length, kind: "comment" });
        }
        continue;
      }
      out.push({ line: lineIdx, startChar: 0, length: end + 2, kind: "comment" });
      i = end + 2;
      inBlockComment = false;
    }

    while (i < line.length) {
      const ch = line[i];
      const next = i + 1 < line.length ? line[i + 1] : "";

      // Whitespace preserves the type-flag silently.
      if (ch === " " || ch === "\t") { i++; continue; }

      // Member access `.` flips state from "type chain" to "property chain"
      // so `cs.IQ_Options` yields builtinGlobal + operator + property, not
      // type + type. Always emits an operator token.
      if (ch === ".") {
        expectingType = false;
        expectingProperty = true;
        out.push({ line: lineIdx, startChar: i, length: 1, kind: "operator" });
        i++;
        continue;
      }

      // `:` sets the type-flag; `:=` is assignment, not a type annotation.
      // Both forms emit operator tokens so themes can color them.
      if (ch === ":") {
        if (next === "=") {
          expectingType = false;
          expectingProperty = false;
          out.push({ line: lineIdx, startChar: i, length: 2, kind: "operator" });
          i += 2;
          continue;
        }
        expectingType = true;
        expectingProperty = false;
        out.push({ line: lineIdx, startChar: i, length: 1, kind: "operator" });
        i++;
        continue;
      }

      // Line comment
      if (ch === "/" && next === "/") {
        expectingType = false;
        expectingProperty = false;
        out.push({ line: lineIdx, startChar: i, length: line.length - i, kind: "comment" });
        i = line.length;
        break;
      }

      // Block comment
      if (ch === "/" && next === "*") {
        expectingType = false;
        expectingProperty = false;
        const end = line.indexOf("*/", i + 2);
        if (end === -1) {
          out.push({ line: lineIdx, startChar: i, length: line.length - i, kind: "comment" });
          inBlockComment = true;
          i = line.length;
          break;
        }
        out.push({ line: lineIdx, startChar: i, length: end + 2 - i, kind: "comment" });
        i = end + 2;
        continue;
      }

      // String literal: "..." with two embedded-quote conventions:
      //   • Doubled "" (4D classic)
      //   • Backslash \" (4D v18+; common in legacy code that pastes JSON or
      //     formula bodies). Other backslash escapes (\\ \n \t \r) are also
      //     swallowed so a stray \\ doesn't truncate the string.
      if (ch === '"') {
        expectingType = false;
        expectingProperty = false;
        let j = i + 1;
        while (j < line.length) {
          if (line[j] === "\\" && j + 1 < line.length) {
            j += 2;
            continue;
          }
          if (line[j] === '"' && line[j + 1] === '"') {
            j += 2;
            continue;
          }
          if (line[j] === '"') {
            j++;
            break;
          }
          j++;
        }
        out.push({ line: lineIdx, startChar: i, length: j - i, kind: "string" });
        i = j;
        continue;
      }

      // Date literal: !YYYY-MM-DD!
      if (ch === "!") {
        const close = line.indexOf("!", i + 1);
        if (close !== -1 && close - i <= 12 && /^\d[\d\-]*$/.test(line.slice(i + 1, close))) {
          expectingType = false;
          expectingProperty = false;
          out.push({ line: lineIdx, startChar: i, length: close + 1 - i, kind: "number" });
          i = close + 1;
          continue;
        }
      }

      // Time literal: ?HH:MM:SS?
      if (ch === "?") {
        const close = line.indexOf("?", i + 1);
        if (close !== -1 && close - i <= 10 && /^\d[\d:]*$/.test(line.slice(i + 1, close))) {
          expectingType = false;
          expectingProperty = false;
          out.push({ line: lineIdx, startChar: i, length: close + 1 - i, kind: "number" });
          i = close + 1;
          continue;
        }
      }

      // Table / field reference:
      //   [Table]       → one tableRef token
      //   [Table]Field  → one fieldRef token covering the whole span
      // Don't fire when `[` is glued to a preceding identifier (`ds[_Foo]`,
      // `cs[_Foo]`) — those are bracket-style collection accesses handled by
      // the symbol pass.
      if (ch === "[" && (i === 0 || !isWordChar(line[i - 1]))) {
        const inner = i + 1;
        if (inner < line.length && isLetterOrUnderscore(line[inner])) {
          let j = inner + 1;
          while (j < line.length && isWordChar(line[j])) j++;
          if (line[j] === "]") {
            expectingType = false;
            expectingProperty = false;
            let endChar = j + 1;
            let kind: LexTokenKind = "tableRef";
            if (endChar < line.length && isLetterOrUnderscore(line[endChar])) {
              let k = endChar;
              while (k < line.length && isWordChar(line[k])) k++;
              endChar = k;
              kind = "fieldRef";
            }
            out.push({ line: lineIdx, startChar: i, length: endChar - i, kind });
            i = endChar;
            continue;
          }
        }
      }

      // Interprocess variable: <> followed by identifier
      if (ch === "<" && next === ">") {
        let j = i + 2;
        if (j < line.length && isLetterOrUnderscore(line[j])) {
          expectingType = false;
          expectingProperty = false;
          j++;
          while (j < line.length && isWordChar(line[j])) j++;
          out.push({ line: lineIdx, startChar: i, length: j - i, kind: "interprocessVar" });
          i = j;
          continue;
        }
      }

      // $-variable: parameter ($0, $1, ...) or local ($name)
      if (ch === "$") {
        expectingType = false;
        expectingProperty = false;
        const nx = next;
        if (isDigit(nx)) {
          let j = i + 1;
          while (j < line.length && isDigit(line[j])) j++;
          // If immediately followed by an identifier char, it's a local
          // variable (e.g. `$12abc`) rather than a parameter.
          if (j < line.length && isWordChar(line[j])) {
            while (j < line.length && isWordChar(line[j])) j++;
            out.push({ line: lineIdx, startChar: i, length: j - i, kind: "localVar" });
          } else {
            out.push({ line: lineIdx, startChar: i, length: j - i, kind: "parameter" });
          }
          i = j;
          continue;
        }
        if (isLetterOrUnderscore(nx)) {
          let j = i + 1;
          while (j < line.length && isWordChar(line[j])) j++;
          out.push({ line: lineIdx, startChar: i, length: j - i, kind: "localVar" });
          i = j;
          continue;
        }
        // Lone $ — skip.
        i++;
        continue;
      }

      // Number literal
      if (isDigit(ch)) {
        expectingType = false;
        expectingProperty = false;
        let j = i;
        if (ch === "0" && (next === "x" || next === "X")) {
          j = i + 2;
          while (j < line.length && isHexDigit(line[j])) j++;
        } else {
          while (j < line.length && isDigit(line[j])) j++;
          if (line[j] === "." && isDigit(line[j + 1])) {
            j++;
            while (j < line.length && isDigit(line[j])) j++;
          }
          if (line[j] === "e" || line[j] === "E") {
            let k = j + 1;
            if (line[k] === "+" || line[k] === "-") k++;
            if (isDigit(line[k])) {
              k++;
              while (k < line.length && isDigit(line[k])) k++;
              j = k;
            }
          }
        }
        out.push({ line: lineIdx, startChar: i, length: j - i, kind: "number" });
        i = j;
        continue;
      }

      // Directive: # at line start (after only whitespace) — `#DECLARE`,
      // `#PROJECT METHOD`, `#PROPERTIES`. The `#` operator (not-equal) in 4D
      // appears mid-expression, never at line start.
      if (ch === "#") {
        expectingType = false;
        expectingProperty = false;
        // Check that everything before `i` on this line is whitespace.
        const leading = line.slice(0, i);
        if (/^\s*$/.test(leading) && isLetterOrUnderscore(line[i + 1] ?? "")) {
          // Greedily eat letters and embedded spaces; stop at first
          // non-letter / non-space.
          let j = i + 1;
          let endOfMatch = j;
          while (j < line.length) {
            if (isLetterOrUnderscore(line[j])) {
              j++;
              endOfMatch = j;
              continue;
            }
            if (line[j] === " " && j + 1 < line.length && isLetterOrUnderscore(line[j + 1])) {
              j++;
              continue;
            }
            break;
          }
          const body = line.slice(i + 1, endOfMatch).replace(/\s+/g, " ").toLowerCase().trim();
          if (DIRECTIVE_NAMES.has(body)) {
            out.push({ line: lineIdx, startChar: i, length: endOfMatch - i, kind: "keyword" });
            i = endOfMatch;
            continue;
          }
        }
        // Not a directive — `#` is the 4D not-equal operator.
        out.push({ line: lineIdx, startChar: i, length: 1, kind: "operator" });
        i++;
        continue;
      }

      // Identifier / keyword / type / property / builtinGlobal
      if (isLetterOrUnderscore(ch)) {
        let j = i;
        while (j < line.length && isWordChar(line[j])) j++;
        const word = line.slice(i, j).toLowerCase();

        // Multi-word keyword (e.g. `End if`, `Class constructor`) beats every
        // other classification — they're never valid in a type / property /
        // builtin-global slot.
        const multi = tryMultiWord(line, i, j);
        if (multi !== null) {
          expectingType = false;
          expectingProperty = false;
          out.push({ line: lineIdx, startChar: i, length: multi - i, kind: "keyword" });
          i = multi;
          continue;
        }

        // After `.`, the identifier is a member-access property. Matches the
        // official 4D extension: in `cs.IQ_Options` the IQ_Options is
        // `property`, not a class/type. Wins over keyword so chained methods
        // like `$x.if` (legal property name) tokenize as property.
        if (expectingProperty) {
          expectingProperty = false;
          expectingType = false;
          out.push({ line: lineIdx, startChar: i, length: j - i, kind: "property" });
          i = j;
          continue;
        }

        // Built-in globals (`cs`, `ds`, `Storage`, `Form`) are always
        // method.defaultLibrary — even in a type-annotation slot. A trailing
        // `.X` then tokenizes as property via the expectingProperty path.
        if (BUILTIN_GLOBALS.has(word)) {
          expectingType = false;
          expectingProperty = false;
          out.push({ line: lineIdx, startChar: i, length: j - i, kind: "builtinGlobal" });
          i = j;
          continue;
        }

        // Type slot beats keyword: `var $x : Object` colors `Object` as type.
        // Non-builtin class names like `MyClass` also land here.
        if (expectingType) {
          out.push({ line: lineIdx, startChar: i, length: j - i, kind: "type" });
          i = j;
          continue;
        }

        if (SINGLE_WORD_KEYWORDS.has(word)) {
          out.push({ line: lineIdx, startChar: i, length: j - i, kind: "keyword" });
        } else if (processVariables && processVariables.has(word)) {
          out.push({ line: lineIdx, startChar: i, length: j - i, kind: "processVar" });
        } else {
          out.push({ line: lineIdx, startChar: i, length: j - i, kind: "identifier" });
        }
        i = j;
        continue;
      }

      // Operators & punctuation.
      const opLen = operatorLength(line, i);
      if (opLen > 0) {
        expectingType = false;
        expectingProperty = false;
        out.push({ line: lineIdx, startChar: i, length: opLen, kind: "operator" });
        i += opLen;
        continue;
      }

      // Anything else — skip and break the type/property chain.
      expectingType = false;
      expectingProperty = false;
      i++;
    }
  }

  return out;
}

/**
 * Match a 4D operator or punctuation token starting at `i`. Returns the token
 * length (1 or 2) or 0 if no operator is present. Caller-owned char handling
 * for `.`, `:`, and `:=` happens earlier in the main loop; this routine
 * covers everything else.
 *
 *   2-char: `>=` `<=` `->`
 *   1-char: `( ) { } ; , + - * / = # < > & | ^`
 */
function operatorLength(line: string, i: number): number {
  const ch = line[i];
  const next = i + 1 < line.length ? line[i + 1] : "";
  if (ch === ">" && next === "=") return 2;
  if (ch === "<" && next === "=") return 2;
  if (ch === "-" && next === ">") return 2;
  switch (ch) {
    case "(": case ")":
    case "{": case "}":
    case ";": case ",":
    case "+": case "-":
    case "*": case "/":
    case "=": case "#":
    case "<": case ">":
    case "&": case "|":
    case "^":
      return 1;
    default:
      return 0;
  }
}

/**
 * Attempt to match a multi-word keyword starting at `wordStart` in `line`,
 * where the first word is already known to end at `firstWordEnd`. Returns the
 * absolute end-of-match index in `line`, or null if no multi-word keyword
 * matches.
 */
function tryMultiWord(line: string, wordStart: number, firstWordEnd: number): number | null {
  const first = line.slice(wordStart, firstWordEnd).toLowerCase();
  let bestEnd: number | null = null;

  for (const parts of MULTI_WORD_PARTS) {
    if (parts[0] !== first) continue;
    let cursor = firstWordEnd;
    let ok = true;
    for (let p = 1; p < parts.length; p++) {
      // skip required whitespace
      let ws = cursor;
      while (ws < line.length && isSpaceOrTab(line[ws])) ws++;
      if (ws === cursor) { ok = false; break; }
      // match next word
      let we = ws;
      while (we < line.length && isWordChar(line[we])) we++;
      if (we === ws) { ok = false; break; }
      const w = line.slice(ws, we).toLowerCase();
      if (w !== parts[p]) { ok = false; break; }
      cursor = we;
    }
    if (!ok) continue;
    // Ensure the keyword isn't immediately continued by another identifier
    // char (e.g. "End ifx" shouldn't match "End if").
    if (cursor < line.length && isWordChar(line[cursor])) continue;
    if (bestEnd === null || cursor > bestEnd) bestEnd = cursor;
  }

  return bestEnd;
}
