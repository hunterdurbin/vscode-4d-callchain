import { CallHint, RawCallSite } from "../model/symbol";

// --- Patterns (run against a comment/string-stripped line) ---
const RE_CALL_WORKER     = /\bCALL\s+WORKER\b\s*\([^"]*?;\s*"(\d+)"/i;
const RE_NEW_PROCESS_STR = /\bNew\s+process\s*\(\s*"(\d+)"/i;
const RE_EXEC_METHOD_STR = /\bEXECUTE\s+METHOD\s*\(\s*"(\d+)"/i;
const RE_EXEC_METHOD_VAR = /\bEXECUTE\s+METHOD\s*\(\s*\$([\w_]+)/i;
const RE_EXEC_IN_SUBFORM = /\bEXECUTE\s+METHOD\s+IN\s+SUBFORM\s*\(\s*"(\d+)"\s*;\s*"(\d+)"/i;
const RE_FORMULA_FROM_STR= /\bFormula\s+from\s+string\s*\(\s*"(\d+)"/i;
const RE_PROCESS_4D_TAGS = /\bProcess\s+4D\s+tags\s*\(/i;
// Form-opening commands take a form name as a string argument. cleanLine
// replaces string literals with `"\x01N\x01"` sentinels — the same convention
// the CALL WORKER / EXECUTE METHOD patterns above rely on.
//
// Several commands accept an optional `[TableName]` argument before the form
// name, e.g. `DIALOG([Invoices]; "Commissions_Admin"; $formData)`. The
// non-capturing group `(?:\[[^\]]+\]\s*;\s*)?` swallows it when present.
const RE_OPEN_FORM_WINDOW   = /\bOpen\s+form\s+window\s*\(\s*"\x01(\d+)\x01"/i;
const RE_DIALOG_FORM        = /\bDIALOG\s*\(\s*(?:\[[^\]]+\]\s*;\s*)?"\x01(\d+)\x01"/i;
const RE_FORM_LOAD          = /\bFORM\s+LOAD\s*\(\s*(?:\[[^\]]+\]\s*;\s*)?"\x01(\d+)\x01"/i;
const RE_PRINT_FORM         = /\bPrint\s+form\s*\(\s*(?:\[[^\]]+\]\s*;\s*)?"\x01(\d+)\x01"/i;
const RE_MODIFY_SELECTION   = /\bMODIFY\s+SELECTION\s*\(\s*\[[^\]]+\]\s*;\s*"\x01(\d+)\x01"/i;
const RE_DISPLAY_SELECTION  = /\bDISPLAY\s+SELECTION\s*\(\s*\[[^\]]+\]\s*;\s*"\x01(\d+)\x01"/i;
// Same commands but with `$var` in the form-name slot — the resolver will
// look up the variable in the method's literal-string map (intra-method scope
// only) and emit a FormRef edge to the recovered form.
const RE_OPEN_FORM_WINDOW_VAR  = /\bOpen\s+form\s+window\s*\(\s*\$([\w_]+)/i;
const RE_DIALOG_FORM_VAR       = /\bDIALOG\s*\(\s*(?:\[[^\]]+\]\s*;\s*)?\$([\w_]+)/i;
const RE_FORM_LOAD_VAR         = /\bFORM\s+LOAD\s*\(\s*(?:\[[^\]]+\]\s*;\s*)?\$([\w_]+)/i;
const RE_PRINT_FORM_VAR        = /\bPrint\s+form\s*\(\s*(?:\[[^\]]+\]\s*;\s*)?\$([\w_]+)/i;
const RE_MODIFY_SELECTION_VAR  = /\bMODIFY\s+SELECTION\s*\(\s*\[[^\]]+\]\s*;\s*\$([\w_]+)/i;
const RE_DISPLAY_SELECTION_VAR = /\bDISPLAY\s+SELECTION\s*\(\s*\[[^\]]+\]\s*;\s*\$([\w_]+)/i;

// Static identifier-based patterns
// 3-segment (component-namespace) forms must be matched before the 2-segment
// `RE_CS_*` ones so cs.NS.Class.new/method() doesn't degrade to an unresolved hint.
const RE_CS_NEW_NS  = /\bcs\.([\w_]+)\.([\w_]+)\.new\s*\(/g;
const RE_CS_CALL_NS = /\bcs\.([\w_]+)\.([\w_]+)\.([\w_]+)\s*\(/g;
const RE_CS_NEW   = /\bcs\.([\w_]+)\.new\s*\(/g;
const RE_CS_CALL  = /\bcs\.([\w_]+)\.([\w_]+)\s*\(/g;
const RE_DS_CALL  = /\bds\.([\w_]+)\.([\w_]+)\s*\(/g;
// Bracket-access dataclass: ds[_TableName].new(...) / .method(...)
// Identifier may have leading underscore (constant convention) or none.
const RE_DS_BRACKET_NEW  = /\bds\s*\[\s*([\w_]+)\s*\]\s*\.\s*new\s*\(/g;
const RE_DS_BRACKET_CALL = /\bds\s*\[\s*([\w_]+)\s*\]\s*\.\s*([\w_]+)\s*\(/g;
const RE_THIS_CALL= /\bThis\.([\w_]+)\s*\(/g;
const RE_SUPER    = /\bSuper(?:\.([\w_]+))?\s*\(/g;
const RE_VAR_CALL = /\$([\w_]+)\.([\w_]+)\s*\(/g;
// Chains starting from `$var` or `This` are extracted by a token scanner
// (`iterateChains`) instead of regex — needed because intermediate method
// calls like `$x.foo().bar.baz()` have `()` mid-chain that regex can't
// balance. Single-step calls (`$x.method()`, `This.method()`) still flow
// through RE_VAR_CALL / RE_THIS_CALL.

// --- Property-access patterns (computed getters / setters) ---
// Assignment forms: `:=` is plain set; `+=`/`-=`/`*=`/`/=` is compound (read + write).
// We capture both `:=` and compound, then post-process to emit get+set for compound.
const RE_THIS_ASSIGN  = /\bThis\.([\w_]+)\s*(:|[+\-*/])=(?!=)/g;
const RE_VAR_ASSIGN   = /(?<![.\w])\$([\w_]+)\.([\w_]+)\s*(:|[+\-*/])=(?!=)/g;
const RE_CS_ASSIGN    = /\bcs\.([\w_]+)\.([\w_]+)\s*(:|[+\-*/])=(?!=)/g;
const RE_CS_ASSIGN_NS = /\bcs\.([\w_]+)\.([\w_]+)\.([\w_]+)\s*(:|[+\-*/])=(?!=)/g;

// Property reads (implicit get). We skip the read pattern when the suffix is `(` (call),
// `.` (chain — handled separately by *_CHAIN), `:=` (assignment), or a compound-op `=`.
// A bare `=` is comparison, which still does invoke the getter — emit. Same for end-of-line.
const RE_THIS_GET       = /\bThis\.([\w_]+)\b(?!\s*\()(?!\s*\.)(?!\s*:=)(?!\s*[+\-*/]=)/g;
const RE_THIS_GET_CHAIN = /\bThis\.([\w_]+)\.(?=[\w_])/g;
const RE_VAR_GET        = /(?<![.\w])\$([\w_]+)\.([\w_]+)\b(?!\s*\()(?!\s*\.)(?!\s*:=)(?!\s*[+\-*/]=)/g;
const RE_VAR_GET_CHAIN  = /(?<![.\w])\$([\w_]+)\.([\w_]+)\.(?=[\w_])/g;

// Bare-name calls: <Capitalized identifier> followed by ( and not preceded by '.', '$', or word chars
// 4D project methods can be camelCase or PascalCase or contain underscores/digits.
// We require the name not to be a reserved keyword (filtered later).
const RE_BARE_CALL = /(?:^|[^A-Za-z0-9_.$])([A-Z][\w_]+|[a-z]+[A-Z][\w_]+)\s*\(/g;

// Formula( ... ) capture — body may itself contain calls; we recurse only one level here.
const RE_FORMULA = /\bFormula\s*\(([^)]*)\)/g;

const RESERVED = new Set<string>([
  "If","Else","Elseif","End","For","While","Repeat","Until","Case",
  "Begin","Use","Function","Class","Try","Catch","Throw","Return",
  "True","False","Null","This","Super","cs","ds","Storage","Form",
  "var","property","local","shared",
  "ARRAY","ARRAY TEXT","ARRAY LONGINT","ARRAY REAL","ARRAY OBJECT",
  "OB","SET","GET",
  "CREATE","SAVE","DELETE","UNLOAD","LOAD","READ","WRITE","QUERY",
  "ORDER","SELECT","SHOW","HIDE","COPY","MOVE","TRACE",
  // ALERT, CONFIRM, REQUEST, BEEP, PAUSE, ABORT, DIALOG, Choose, Sum, Min,
  // Max, Count, Average are all real 4D builtins. They must flow through
  // the bare-name path so the resolver maps them to Builtin symbols and
  // produces caller edges. Don't add them here.
  // Form constants commonly called like functions in some legacy code:
  "Form","FORM"
]);

interface ScannedChainSegment {
  name: string;
  isCall: boolean;
  /** Position of `name`'s first character in the source line. */
  nameStart: number;
  /** Exclusive end position of `name` in the source line. */
  nameEnd: number;
}

interface ScannedChain {
  /** Position in `line` where the head (`$var` or `This`) starts. */
  startChar: number;
  /** Position in `line` where the chain ends (one past the terminal `)`). */
  endChar: number;
  /** Head of the chain — either a $-variable or `This`. */
  head: { kind: "var"; variable: string } | { kind: "this" };
  /** Ordered segments after the head; the last entry is the terminal call. */
  segments: ScannedChainSegment[];
}

/**
 * Find every `$var.<...>(` or `This.<...>(` chain on a line. Handles
 * intermediate method calls (`$x.foo().bar.baz()`) via balanced-paren scanning
 * rather than regex. Each result's last segment is guaranteed `isCall: true`.
 */
function iterateChains(line: string): ScannedChain[] {
  const out: ScannedChain[] = [];
  const isWord = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c);
  let i = 0;
  while (i < line.length) {
    let head: ScannedChain["head"] | undefined;
    let pos = i;
    const prev = i > 0 ? line[i - 1] : undefined;
    if (line[i] === "$" && !isWord(prev)) {
      let j = i + 1;
      while (j < line.length && /[\w_]/.test(line[j])) j++;
      if (j > i + 1) {
        head = { kind: "var", variable: line.slice(i + 1, j) };
        pos = j;
      }
    } else if (
      line.slice(i, i + 4) === "This" &&
      !isWord(prev) &&
      !isWord(line[i + 4]) &&
      line[i + 4] !== "(" // exclude `This(...)` (constructor invocation, distinct pattern)
    ) {
      head = { kind: "this" };
      pos = i + 4;
    }
    if (!head) { i++; continue; }

    const segments: ScannedChainSegment[] = [];
    let aborted = false;
    while (pos < line.length && line[pos] === ".") {
      const nameStart = pos + 1;
      let j = nameStart;
      while (j < line.length && /[\w_]/.test(line[j])) j++;
      if (j === nameStart) break;
      const name = line.slice(nameStart, j);
      const nameEnd = j;
      let k = j;
      while (k < line.length && line[k] === " ") k++;
      let isCall = false;
      if (line[k] === "(") {
        isCall = true;
        let depth = 1;
        let p = k + 1;
        while (p < line.length && depth > 0) {
          const c = line[p];
          if (c === "(") depth++;
          else if (c === ")") depth--;
          p++;
        }
        if (depth !== 0) { aborted = true; break; }
        pos = p;
      } else {
        pos = j;
      }
      segments.push({ name, isCall, nameStart, nameEnd });
    }

    if (!aborted && segments.length > 0 && segments[segments.length - 1].isCall) {
      out.push({ startChar: i, endChar: pos, head, segments });
    }
    i = pos > i ? pos : i + 1;
  }
  return out;
}

/**
 * Helper: locate a named capture inside the overall match `m[0]`. Searches
 * `m[0]` for the captured substring starting at `startWithin` and returns
 * absolute source-line positions. If `captured` is unique within `m[0]` (the
 * common case for our patterns), this is exact.
 */
function locateInMatch(
  m: RegExpExecArray,
  captured: string,
  startWithin: number
): { column: number; endColumn: number } {
  const at = m[0].indexOf(captured, startWithin);
  if (at === -1) {
    return { column: m.index!, endColumn: m.index! + m[0].length };
  }
  return { column: m.index! + at, endColumn: m.index! + at + captured.length };
}

/**
 * Emit zero-or-more raw call sites from a single (already cleaned) source line.
 * Emitted column / endColumn are in CLEANED-LINE coordinates; callers translate
 * via the `cols` array returned by `cleanLine` to recover raw-line positions.
 *
 * @param constantsSet If provided, any bare identifier matching a name in this
 *                     set is emitted as a `ConstantRef` hint. Without it, the
 *                     extractor cannot tell a constant from a local variable.
 */
export function extractCallSitesFromLine(
  line: string,
  strings: string[],
  fromSymbolId: string,
  lineNumber: number,
  constantsSet?: Set<string>,
  localStrings?: Map<string, string>
): RawCallSite[] {
  const out: RawCallSite[] = [];
  const push = (
    hint: CallHint,
    expression: string,
    column?: number,
    endColumn?: number
  ) => {
    out.push({ fromSymbolId, line: lineNumber, raw: line.trim(), expression, hint, column, endColumn });
  };

  // --- High-priority structured calls first (don't double-count their inner pattern) ---
  let m: RegExpMatchArray | null;
  if ((m = line.match(RE_EXEC_IN_SUBFORM))) {
    const form = strings[Number(m[1])];
    const method = strings[Number(m[2])];
    if (form && method) {
      const col = m.index ?? 0;
      push({ kind: "ExecuteMethodInSubform", formName: form, methodName: method }, m[0], col, col + m[0].length);
    }
  }
  if ((m = line.match(RE_CALL_WORKER))) {
    const name = strings[Number(m[1])];
    if (name) {
      const col = m.index ?? 0;
      push({ kind: "CallWorker", methodName: name }, m[0], col, col + m[0].length);
    }
  }
  if ((m = line.match(RE_NEW_PROCESS_STR))) {
    const name = strings[Number(m[1])];
    if (name) {
      const col = m.index ?? 0;
      push({ kind: "NewProcess", methodName: name }, m[0], col, col + m[0].length);
    }
  }
  if ((m = line.match(RE_EXEC_METHOD_STR))) {
    const name = strings[Number(m[1])];
    if (name) {
      const col = m.index ?? 0;
      push({ kind: "ExecuteMethodLiteral", methodName: name }, m[0], col, col + m[0].length);
    }
  }
  if ((m = line.match(RE_EXEC_METHOD_VAR))) {
    const col = m.index ?? 0;
    push({ kind: "ExecuteMethodDynamic", variable: m[1] }, m[0], col, col + m[0].length);
  }
  if ((m = line.match(RE_FORMULA_FROM_STR))) {
    const body = strings[Number(m[1])];
    if (body) {
      const col = m.index ?? 0;
      push({ kind: "Formula", body }, m[0], col, col + m[0].length);
    }
  }
  const pushFormMatch = (
    matched: RegExpMatchArray | null,
    formName: string | undefined
  ) => {
    if (!matched || !formName) return;
    const col = matched.index ?? 0;
    push({ kind: "FormRef", formName }, matched[0], col, col + matched[0].length);
  };
  if ((m = line.match(RE_OPEN_FORM_WINDOW))) pushFormMatch(m, strings[Number(m[1])]);
  if ((m = line.match(RE_DIALOG_FORM)))      pushFormMatch(m, strings[Number(m[1])]);
  if ((m = line.match(RE_FORM_LOAD)))        pushFormMatch(m, strings[Number(m[1])]);
  if ((m = line.match(RE_PRINT_FORM)))       pushFormMatch(m, strings[Number(m[1])]);
  if ((m = line.match(RE_MODIFY_SELECTION))) pushFormMatch(m, strings[Number(m[1])]);
  if ((m = line.match(RE_DISPLAY_SELECTION)))pushFormMatch(m, strings[Number(m[1])]);
  // Variable-form variants — resolve `$var` against the method's local
  // string-literal map AT THIS LINE so subsequent reassignments don't
  // retroactively change earlier call sites. Drop silently if the
  // variable hasn't been assigned a string literal yet.
  const pushFormVar = (varName: string, raw: string, col: number, endCol: number) => {
    const literal = localStrings?.get(varName);
    if (literal) push({ kind: "FormRef", formName: literal }, raw, col, endCol);
  };
  const pushFormVarMatch = (matched: RegExpMatchArray | null) => {
    if (!matched) return;
    const col = matched.index ?? 0;
    pushFormVar(matched[1], matched[0], col, col + matched[0].length);
  };
  pushFormVarMatch(line.match(RE_OPEN_FORM_WINDOW_VAR));
  pushFormVarMatch(line.match(RE_DIALOG_FORM_VAR));
  pushFormVarMatch(line.match(RE_FORM_LOAD_VAR));
  pushFormVarMatch(line.match(RE_PRINT_FORM_VAR));
  pushFormVarMatch(line.match(RE_MODIFY_SELECTION_VAR));
  pushFormVarMatch(line.match(RE_DISPLAY_SELECTION_VAR));

  // --- cs.NS.Class.new(...) — component-class constructor ---
  // Tracked positions so the 2-segment fallback doesn't double-attribute.
  const consumedCsSpans: Array<[number, number]> = [];
  let re = new RegExp(RE_CS_NEW_NS);
  let mx: RegExpExecArray | null;
  while ((mx = re.exec(line))) {
    // Highlight the Class identifier (m[2]) — that's the salient piece.
    const loc = locateInMatch(mx, mx[2], 3 + mx[1].length + 1); // past "cs.NS."
    push({ kind: "CsNewNs", namespace: mx[1], className: mx[2] }, mx[0], loc.column, loc.endColumn);
    consumedCsSpans.push([mx.index!, mx.index! + mx[0].length]);
  }

  // --- cs.NS.Class.method(...) — component-class function ---
  re = new RegExp(RE_CS_CALL_NS);
  while ((mx = re.exec(line))) {
    if (mx[3] === "new") continue;
    const loc = locateInMatch(mx, mx[3], 3 + mx[1].length + 1 + mx[2].length + 1);
    push({ kind: "CsCallNs", namespace: mx[1], className: mx[2], method: mx[3] }, mx[0], loc.column, loc.endColumn);
    consumedCsSpans.push([mx.index!, mx.index! + mx[0].length]);
  }

  const inConsumed = (start: number): boolean =>
    consumedCsSpans.some(([s, e]) => start >= s && start < e);

  // --- cs.X.new(...) ---
  re = new RegExp(RE_CS_NEW);
  while ((mx = re.exec(line))) {
    if (inConsumed(mx.index!)) continue;
    const loc = locateInMatch(mx, mx[1], 3); // past "cs."
    push({ kind: "CsNew", className: mx[1] }, mx[0], loc.column, loc.endColumn);
  }

  // --- cs.X.method(...) — but skip if it's actually cs.X.new (already captured)
  re = new RegExp(RE_CS_CALL);
  while ((mx = re.exec(line))) {
    if (mx[2] === "new") continue;
    if (inConsumed(mx.index!)) continue;
    const loc = locateInMatch(mx, mx[2], 3 + mx[1].length + 1);
    push({ kind: "CsCall", className: mx[1], method: mx[2] }, mx[0], loc.column, loc.endColumn);
  }

  // --- ds.X.method(...) ---
  re = new RegExp(RE_DS_CALL);
  while ((mx = re.exec(line))) {
    const loc = locateInMatch(mx, mx[2], 3 + mx[1].length + 1);
    push({ kind: "DsCall", className: mx[1], method: mx[2] }, mx[0], loc.column, loc.endColumn);
  }

  // --- ds[_X].new(...) and ds[_X].method(...) ---
  re = new RegExp(RE_DS_BRACKET_NEW);
  while ((mx = re.exec(line))) {
    // Highlight `new` — the call site identifier.
    const loc = locateInMatch(mx, "new", 0);
    push({ kind: "DsBracketNew", ident: mx[1] }, mx[0], loc.column, loc.endColumn);
  }
  re = new RegExp(RE_DS_BRACKET_CALL);
  while ((mx = re.exec(line))) {
    if (mx[2] === "new") continue;
    const loc = locateInMatch(mx, mx[2], mx[0].indexOf("]") + 1);
    push({ kind: "DsBracketCall", ident: mx[1], method: mx[2] }, mx[0], loc.column, loc.endColumn);
  }

  // --- $var / This chains: tokenize each call site in the chain.
  // For each chain, emit:
  //   - VarCall / ThisCall for the leftmost terminal call (path.length === 0)
  //   - VarChainCall / ThisChainCall for any subsequent call sites with the
  //     accumulated path of prior segments (mix of properties and calls).
  // Sub-spans consumed by chain emissions are recorded so the legacy
  // RE_VAR_CALL / RE_THIS_CALL passes below don't double-count.
  const consumedChainSpans: Array<[number, number]> = [];
  for (const chain of iterateChains(line)) {
    consumedChainSpans.push([chain.startChar, chain.endChar]);
    const exprFull = line.slice(chain.startChar, chain.endChar);
    for (let i = 0; i < chain.segments.length; i++) {
      const seg = chain.segments[i];
      if (!seg.isCall) continue;
      const prior = chain.segments.slice(0, i).map((s) => ({ name: s.name, isCall: s.isCall }));
      const method = seg.name;
      const col = seg.nameStart;
      const endCol = seg.nameEnd;
      if (chain.head.kind === "var") {
        if (prior.length === 0) {
          push({ kind: "VarCall", variable: chain.head.variable, method }, exprFull, col, endCol);
        } else {
          push({ kind: "VarChainCall", variable: chain.head.variable, path: prior, method }, exprFull, col, endCol);
        }
      } else {
        if (prior.length === 0) {
          push({ kind: "ThisCall", method }, exprFull, col, endCol);
        } else {
          push({ kind: "ThisChainCall", path: prior, method }, exprFull, col, endCol);
        }
      }
    }
  }

  // --- This.method(...) — fallback for plain `This.method()` not part of a
  // dotted chain. Most cases are already handled above; this regex catches
  // anything the tokenizer missed (defense in depth — overlapping matches are
  // suppressed via consumedChainSpans).
  re = new RegExp(RE_THIS_CALL);
  while ((mx = re.exec(line))) {
    if (consumedChainSpans.some(([s, e]) => mx!.index! >= s && mx!.index! < e)) continue;
    const loc = locateInMatch(mx, mx[1], "This.".length);
    push({ kind: "ThisCall", method: mx[1] }, mx[0], loc.column, loc.endColumn);
  }

  // --- Super(...) and Super.method(...) ---
  re = new RegExp(RE_SUPER);
  while ((mx = re.exec(line))) {
    const loc = mx[1]
      ? locateInMatch(mx, mx[1], "Super.".length)
      : { column: mx.index!, endColumn: mx.index! + "Super".length };
    push({ kind: "SuperCall", method: mx[1] }, mx[0], loc.column, loc.endColumn);
  }

  // --- $var.method(...) — fallback for any single-step `$x.method()` call
  // that escaped the tokenizer (rare; defense in depth).
  re = new RegExp(RE_VAR_CALL);
  while ((mx = re.exec(line))) {
    if (consumedChainSpans.some(([s, e]) => mx!.index! >= s && mx!.index! < e)) continue;
    const loc = locateInMatch(mx, mx[2], 1 + mx[1].length + 1); // past "$var."
    push({ kind: "VarCall", variable: mx[1], method: mx[2] }, mx[0], loc.column, loc.endColumn);
  }

  // --- Property assignments (set, and compound = set + get) ---
  re = new RegExp(RE_THIS_ASSIGN);
  while ((mx = re.exec(line))) {
    const prop = mx[1];
    const op = mx[2]; // ":" for `:=`, otherwise compound op
    const loc = locateInMatch(mx, prop, "This.".length);
    if (op !== ":") push({ kind: "ThisGet", property: prop }, mx[0], loc.column, loc.endColumn);
    push({ kind: "ThisSet", property: prop }, mx[0], loc.column, loc.endColumn);
  }
  re = new RegExp(RE_VAR_ASSIGN);
  while ((mx = re.exec(line))) {
    const variable = mx[1];
    const prop = mx[2];
    const op = mx[3];
    const loc = locateInMatch(mx, prop, 1 + variable.length + 1);
    if (op !== ":") push({ kind: "VarGet", variable, property: prop }, mx[0], loc.column, loc.endColumn);
    push({ kind: "VarSet", variable, property: prop }, mx[0], loc.column, loc.endColumn);
  }
  re = new RegExp(RE_CS_ASSIGN);
  while ((mx = re.exec(line))) {
    const className = mx[1];
    const prop = mx[2];
    const op = mx[3];
    const loc = locateInMatch(mx, prop, 3 + className.length + 1);
    if (op !== ":") push({ kind: "CsGet", className, property: prop }, mx[0], loc.column, loc.endColumn);
    push({ kind: "CsSet", className, property: prop }, mx[0], loc.column, loc.endColumn);
  }

  // --- Property reads (implicit get) ---
  re = new RegExp(RE_THIS_GET);
  while ((mx = re.exec(line))) {
    const loc = locateInMatch(mx, mx[1], "This.".length);
    push({ kind: "ThisGet", property: mx[1] }, mx[0], loc.column, loc.endColumn);
  }
  re = new RegExp(RE_THIS_GET_CHAIN);
  while ((mx = re.exec(line))) {
    const loc = locateInMatch(mx, mx[1], "This.".length);
    push({ kind: "ThisGet", property: mx[1] }, mx[0], loc.column, loc.endColumn);
  }
  re = new RegExp(RE_VAR_GET);
  while ((mx = re.exec(line))) {
    const loc = locateInMatch(mx, mx[2], 1 + mx[1].length + 1);
    push({ kind: "VarGet", variable: mx[1], property: mx[2] }, mx[0], loc.column, loc.endColumn);
  }
  re = new RegExp(RE_VAR_GET_CHAIN);
  while ((mx = re.exec(line))) {
    const loc = locateInMatch(mx, mx[2], 1 + mx[1].length + 1);
    push({ kind: "VarGet", variable: mx[1], property: mx[2] }, mx[0], loc.column, loc.endColumn);
  }

  // --- Formula( ... ) body — capture multi-word + bare-name + $var.method ---
  // Mirror the outer-line scanner's ordering: multi-word commands first so the
  // bare-name pass can skip identifiers consumed by them. Without this,
  // `Formula(PgSQL Set Boolean In SQL($1; $2; ...))` emits a stray `SQL`
  // unresolved.
  re = new RegExp(RE_FORMULA);
  while ((mx = re.exec(line))) {
    const body = mx[1];
    const bodyStart = mx.index! + mx[0].indexOf(body, "Formula".length);
    const innerConsumed: Array<[number, number]> = [];
    const innerMultiWord = /(?<=^|[^A-Za-z0-9_.$])([A-Z_][\w]*(?:\s+[A-Za-z][\w]*){1,4})\s*\(/g;
    let mwInner: RegExpExecArray | null;
    while ((mwInner = innerMultiWord.exec(body))) {
      const name = mwInner[1].replace(/\s+/g, " ").trim();
      if (name.length > 80) continue;
      const within = mwInner[0].indexOf(mwInner[1]);
      const col = bodyStart + mwInner.index! + within;
      push({ kind: "BuiltinChain", name }, mwInner[0], col, col + mwInner[1].length);
      innerConsumed.push([col, col + mwInner[1].length]);
    }
    const inner = body.matchAll(RE_BARE_CALL);
    for (const im of inner) {
      const name = im[1];
      if (RESERVED.has(name)) continue;
      const within = im[0].indexOf(name);
      const col = bodyStart + im.index! + within;
      if (innerConsumed.some(([a, b]) => col >= a && col < b)) continue;
      push({ kind: "BareName", name }, im[0], col, col + name.length);
    }
    // Also detect $var.method inside formula
    const innerVar = body.matchAll(RE_VAR_CALL);
    for (const im of innerVar) {
      const within = im[0].indexOf(im[2], 1 + im[1].length + 1);
      const col = bodyStart + im.index! + within;
      push({ kind: "VarCall", variable: im[1], method: im[2] }, im[0], col, col + im[2].length);
    }
  }

  // --- Interprocess variable references: `<>name` is unambiguous syntax. ---
  // Emit always — the resolver drops if no matching InterprocessVariable exists.
  const RE_INTERPROCESS = /(?<![.$\w])<>([A-Za-z_][\w_]*)/g;
  let ipMatch: RegExpExecArray | null;
  while ((ipMatch = RE_INTERPROCESS.exec(line))) {
    const name = ipMatch[1];
    const after = line.slice(ipMatch.index + ipMatch[0].length);
    if (/^\s*\(/.test(after)) continue; // method call
    const col = ipMatch.index!;
    push({ kind: "InterprocessRef", name }, ipMatch[0], col, col + ipMatch[0].length);
  }

  // --- Bare identifiers used as values (constant references) ---
  // Constants in 4D have many naming patterns:
  //   `_Rules`, `MODULE_INVOICES`, `4X_TYPE_*`, `Worker_Backend` — single-word
  //   `Char Quote`, `Is text`, `On Load`, `Form event code` — multi-word
  // We tokenize the line into identifier words, then at each starting position
  // try matching the longest constant name (1 to 5 words) against the known
  // constants set. Words consumed by a longer match are skipped so we don't
  // double-emit (e.g. `Char Quote` shouldn't also emit `Quote` separately).
  if (constantsSet && constantsSet.size > 0) {
    const RE_WORD = /(?<![.$\w\[\]])\w+\b/g;
    const positions: Array<{ word: string; start: number; end: number }> = [];
    let wm: RegExpExecArray | null;
    while ((wm = RE_WORD.exec(line))) {
      positions.push({ word: wm[0], start: wm.index, end: wm.index + wm[0].length });
    }
    const consumed = new Array(positions.length).fill(false);
    for (let i = 0; i < positions.length; i++) {
      if (consumed[i]) continue;
      let matchedLen = 0;
      let matchedName = "";
      for (let len = Math.min(5, positions.length - i); len >= 1; len--) {
        let contiguous = true;
        for (let j = i + 1; j < i + len; j++) {
          const gap = line.slice(positions[j - 1].end, positions[j].start);
          if (!/^[ \t]+$/.test(gap)) { contiguous = false; break; }
        }
        if (!contiguous) continue;
        const candidate = positions.slice(i, i + len).map((p) => p.word).join(" ");
        if (constantsSet.has(candidate.toLowerCase())) {
          matchedLen = len;
          matchedName = candidate;
          break;
        }
      }
      if (matchedLen === 0) continue;
      const endPos = positions[i + matchedLen - 1].end;
      const after = line.slice(endPos);
      if (/^\s*\(/.test(after)) continue;
      const startPos = positions[i].start;
      push({ kind: "ConstantRef", name: matchedName }, matchedName, startPos, endPos);
      for (let j = 0; j < matchedLen; j++) consumed[i + j] = true;
    }
  }

  // --- Whole-line "X Y(..." style 4D commands (e.g., HTTP Get(...) / Process 4D tags(...))
  // We run this BEFORE the bare-name pass so we can record the source-text spans
  // these matches consume; the bare pass will skip any name that falls inside.
  // Without this, `CREATE RECORD([Inventory])` produces two edges:
  //   • multi-word: "CREATE RECORD" (resolved → Builtin) — correct
  //   • bare:       "RECORD"        (Unresolved)        — bug
  // Allow underscore-led first words so legacy commands like `_O_PAGE SETUP(`
  // resolve as multi-word builtins instead of leaking a bare `SETUP`. The
  // boundary uses a lookbehind so the preceding `(` isn't consumed — without
  // that, `Generate digest(JSON Stringify(...))` matches the outer call but
  // then can't anchor on the inner `(` boundary, leaving `Stringify` to leak
  // through the bare-name pass.
  const multiWordCall = /(?<=^|[^A-Za-z0-9_.$])([A-Z_][\w]*(?:\s+[A-Za-z][\w]*){1,4})\s*\(/g;
  let mw: RegExpMatchArray | null;
  const consumedSpans: Array<[number, number]> = [];
  while ((mw = multiWordCall.exec(line))) {
    const name = mw[1].replace(/\s+/g, " ").trim();
    if (name.length > 80) continue;
    const nameStart = mw.index! + mw[0].indexOf(mw[1]);
    push({ kind: "BuiltinChain", name }, mw[0], nameStart, nameStart + mw[1].length);
    consumedSpans.push([nameStart, nameStart + mw[1].length]);
  }

  // --- Parenthesis-less project method calls ---
  // 4D allows calling a parameterless project method by name alone as a
  // statement (its own line). Match a line that's nothing but an identifier
  // after the cleanLine pass strips comments/strings. The resolver maps the
  // name to a project method if one exists and drops silently otherwise —
  // we never want random identifiers becoming Unresolved symbols.
  const bareStatement = line.match(/^(\s*)([A-Z][\w_]+|[a-z]+[A-Z][\w_]+)\s*$/);
  if (bareStatement) {
    const name = bareStatement[2];
    if (!RESERVED.has(name)) {
      const col = bareStatement[1].length;
      push({ kind: "ProjectMethodBare", name }, name, col, col + name.length);
    }
  }

  // --- Bare-name calls (project methods, builtins, plugins) ---
  // Avoid matching method-chain receivers like ".save(", "$x.foo(", "cs.X.fn(".
  re = new RegExp(RE_BARE_CALL);
  while ((mx = re.exec(line))) {
    const name = mx[1];
    if (RESERVED.has(name)) continue;
    const start = mx.index! + mx[0].indexOf(name);
    const prevChar = start > 0 ? line[start - 1] : "";
    if (prevChar === "." || prevChar === "$" || prevChar === ":" || prevChar === "#") continue;
    if (consumedSpans.some(([a, b]) => start >= a && start < b)) continue;
    push({ kind: "BareName", name }, mx[0], start, start + name.length);
  }

  return out;
}

// `RE_PROCESS_4D_TAGS` retained in module scope for completeness with future
// emission additions; suppress an unused-symbol warning here.
void RE_PROCESS_4D_TAGS;
void RE_CS_ASSIGN_NS;
