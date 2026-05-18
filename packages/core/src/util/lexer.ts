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
  | "builtinCommand"
  | "pluginCommand"
  | "property"
  | "operator"
  | "identifier";

export interface TokenizeOptions {
  /** Lowercased names of declared process / interprocess variables. Matched
   *  case-insensitively against bare identifiers. When omitted, no
   *  `processVar` tokens are emitted. */
  processVariables?: Set<string>;
  /** Case-preserving names of plugin commands discovered in the project's
   *  Plugins/*.bundle manifests (e.g. `"PgSQL Connect"`, `"WP New"`). Matched
   *  case-insensitively. Treated symmetrically with the static 4D builtins:
   *  multi-word names lex to a single `pluginCommand` token; single-word
   *  names lex to `pluginCommand` instead of falling through to `identifier`.
   *  When omitted, no `pluginCommand` tokens are emitted. */
  pluginCommands?: Set<string>;
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

// Lookup tables for 4D's built-in commands (sourced from
// `packages/core/src/model/builtins.json`). Two flavors:
//   • BUILTIN_SINGLE — lowercased single-word command names (e.g. `length`,
//     `string`, `type`).
//   • BUILTIN_MULTI  — first-word → list of remaining-word arrays, ordered
//     longest-first so the matcher tries `OB Is defined` before `OB Is`.
// Both are populated lazily on first call so a cold tokenizer doesn't pay
// the build cost up front.
import builtinsData from "../model/builtins.json";

let BUILTIN_SINGLE: Set<string> | null = null;
let BUILTIN_MULTI: Map<string, string[][]> | null = null;

function ensureBuiltins(): { single: Set<string>; multi: Map<string, string[][]> } {
  if (BUILTIN_SINGLE && BUILTIN_MULTI) return { single: BUILTIN_SINGLE, multi: BUILTIN_MULTI };
  const single = new Set<string>();
  const multi = new Map<string, string[][]>();
  for (const raw of (builtinsData as { commands: string[] }).commands) {
    const lower = raw.toLowerCase();
    const parts = lower.split(/\s+/);
    if (parts.length === 0) continue;
    // First-word must start with letter/underscore — `4D`, `#DECLARE` etc.
    // are handled in dedicated paths and aren't relevant here.
    if (!/^[a-z_]/.test(parts[0])) continue;
    if (parts.length === 1) {
      single.add(parts[0]);
    } else {
      const arr = multi.get(parts[0]) ?? [];
      arr.push(parts.slice(1));
      multi.set(parts[0], arr);
    }
  }
  for (const arr of multi.values()) {
    arr.sort((a, b) => b.length - a.length);
  }
  BUILTIN_SINGLE = single;
  BUILTIN_MULTI = multi;
  return { single, multi };
}

// Per-project plugin command lookup tables. Plugin command lists are
// per-project (parsed from each `<projectRoot>/Plugins/*.bundle/Contents/
// Resources/manifest.json`), so unlike the static 4D builtins we can't
// memoize globally. We cache by Set identity — the semantic-tokens handler
// passes the same Set across calls within an index generation, so this
// pays the split-into-{single,multi} cost once per index rebuild.
const PLUGIN_LOOKUP_CACHE = new WeakMap<
  Set<string>,
  { single: Set<string>; multi: Map<string, string[][]> }
>();

function pluginLookup(
  names: Set<string>
): { single: Set<string>; multi: Map<string, string[][]> } {
  const cached = PLUGIN_LOOKUP_CACHE.get(names);
  if (cached) return cached;
  const single = new Set<string>();
  const multi = new Map<string, string[][]>();
  for (const raw of names) {
    const lower = raw.toLowerCase();
    const parts = lower.split(/\s+/);
    if (parts.length === 0) continue;
    if (!/^[a-z_]/.test(parts[0])) continue;
    if (parts.length === 1) {
      single.add(parts[0]);
    } else {
      const arr = multi.get(parts[0]) ?? [];
      arr.push(parts.slice(1));
      multi.set(parts[0], arr);
    }
  }
  for (const arr of multi.values()) {
    arr.sort((a, b) => b.length - a.length);
  }
  const out = { single, multi };
  PLUGIN_LOOKUP_CACHE.set(names, out);
  return out;
}

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
  const pluginNames = options?.pluginCommands;
  const plugin = pluginNames && pluginNames.size > 0 ? pluginLookup(pluginNames) : null;

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
    // Set when the identifier branch tags an object-literal property key
    // (`{bCheckPaid: ...}`). Tells the next `:` to behave as a separator
    // instead of opening a type-annotation context.
    let propertyKeyColonPending = false;

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
          propertyKeyColonPending = false;
          out.push({ line: lineIdx, startChar: i, length: 2, kind: "operator" });
          i += 2;
          continue;
        }
        // Object-literal separator (`{key: value}`) — emit the colon but do
        // NOT open a type-annotation context. The flag is set by the
        // identifier branch when it tags the preceding identifier as a
        // property key.
        if (propertyKeyColonPending) {
          propertyKeyColonPending = false;
          expectingType = false;
          expectingProperty = false;
          out.push({ line: lineIdx, startChar: i, length: 1, kind: "operator" });
          i++;
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

        // Multi-word 4D builtin (`Count parameters`, `OB Is defined`,
        // `New object`, `Current method name`). Run before keyword / type
        // checks so the WHOLE span lands on one token.
        const multiBuiltin = tryMultiWordBuiltin(line, i, j);
        if (multiBuiltin !== null) {
          expectingType = false;
          expectingProperty = false;
          out.push({ line: lineIdx, startChar: i, length: multiBuiltin - i, kind: "builtinCommand" });
          i = multiBuiltin;
          continue;
        }

        // Multi-word plugin command (`PgSQL Connect`, `WP New`). Same
        // matching strategy as builtins — claim the whole span so the
        // semantic-tokens handler can paint `method.plugin`.
        if (plugin) {
          const multiPlugin = tryMultiWordFromTable(line, i, j, plugin.multi);
          if (multiPlugin !== null) {
            expectingType = false;
            expectingProperty = false;
            out.push({ line: lineIdx, startChar: i, length: multiPlugin - i, kind: "pluginCommand" });
            i = multiPlugin;
            continue;
          }
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
          i = j;
          continue;
        }

        // Object-literal property key: bare identifier immediately followed
        // by `:` (and not `:=` / `::`). Example: `{bCheckPaid: True}` — both
        // `bCheckPaid` and a subsequent `myProperty2` in
        // `{myProperty: "value"; myProperty2: 200.20}` are property names.
        // Wins over `processVar` so a process variable named like a key
        // still colors as property in this slot.
        if (isPropertyKeyColon(line, j)) {
          propertyKeyColonPending = true;
          out.push({ line: lineIdx, startChar: i, length: j - i, kind: "property" });
          i = j;
          continue;
        }

        // Single-word 4D builtin (e.g. `Length`, `String`, `Type`). The
        // call-graph symbol pass would also tag these when called with
        // parens, but bare references without parens (rare but legal in
        // some contexts) still get colored here.
        const { single } = ensureBuiltins();
        if (single.has(word)) {
          out.push({ line: lineIdx, startChar: i, length: j - i, kind: "builtinCommand" });
          i = j;
          continue;
        }

        // Single-word plugin command (e.g. some plugins expose flat names
        // like `WP_New_Document`).
        if (plugin && plugin.single.has(word)) {
          out.push({ line: lineIdx, startChar: i, length: j - i, kind: "pluginCommand" });
          i = j;
          continue;
        }

        if (processVariables && processVariables.has(word)) {
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
 * Match a multi-word 4D builtin (e.g. `Count parameters`, `OB Is defined`)
 * starting at `wordStart`, where the first word ends at `firstWordEnd`.
 * Longest-first via the lookup table's sort order. Returns the absolute
 * end-of-match index in `line`, or null if no multi-word builtin matches.
 */
function tryMultiWordBuiltin(line: string, wordStart: number, firstWordEnd: number): number | null {
  const { multi } = ensureBuiltins();
  return tryMultiWordFromTable(line, wordStart, firstWordEnd, multi);
}

/**
 * Generic multi-word matcher. Used by both the static builtin path and the
 * per-project plugin-command path — same boundary rules and longest-first
 * semantics, only the source table differs.
 */
function tryMultiWordFromTable(
  line: string,
  wordStart: number,
  firstWordEnd: number,
  table: Map<string, string[][]>
): number | null {
  const first = line.slice(wordStart, firstWordEnd).toLowerCase();
  const candidates = table.get(first);
  if (!candidates) return null;
  for (const parts of candidates) {
    let cursor = firstWordEnd;
    let ok = true;
    for (const expected of parts) {
      let ws = cursor;
      while (ws < line.length && isSpaceOrTab(line[ws])) ws++;
      if (ws === cursor) { ok = false; break; }
      let we = ws;
      while (we < line.length && isWordChar(line[we])) we++;
      if (we === ws) { ok = false; break; }
      const w = line.slice(ws, we).toLowerCase();
      if (w !== expected) { ok = false; break; }
      cursor = we;
    }
    if (!ok) continue;
    if (cursor < line.length && isWordChar(line[cursor])) continue;
    return cursor;
  }
  return null;
}

/**
 * Look ahead from `j` (end of an identifier) and decide whether the next
 * non-whitespace char is `:` acting as an object-literal property separator.
 * Excludes `:=` (assignment) and `::` (rare; not really 4D syntax but cheap
 * to guard against).
 */
function isPropertyKeyColon(line: string, j: number): boolean {
  let k = j;
  while (k < line.length && (line[k] === " " || line[k] === "\t")) k++;
  if (line[k] !== ":") return false;
  if (line[k + 1] === "=") return false;
  if (line[k + 1] === ":") return false;
  return true;
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
