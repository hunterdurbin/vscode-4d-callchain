import { CallHint, RawCallSite } from "../model/symbol";

// --- Patterns (run against a comment/string-stripped line) ---
const RE_CALL_WORKER     = /\bCALL\s+WORKER\b\s*\([^"]*?;\s*"(\d+)"/i;
const RE_NEW_PROCESS_STR = /\bNew\s+process\s*\(\s*"(\d+)"/i;
const RE_EXEC_METHOD_STR = /\bEXECUTE\s+METHOD\s*\(\s*"(\d+)"/i;
const RE_EXEC_METHOD_VAR = /\bEXECUTE\s+METHOD\s*\(\s*\$([\w_]+)/i;
const RE_EXEC_IN_SUBFORM = /\bEXECUTE\s+METHOD\s+IN\s+SUBFORM\s*\(\s*"(\d+)"\s*;\s*"(\d+)"/i;
const RE_FORMULA_FROM_STR= /\bFormula\s+from\s+string\s*\(\s*"(\d+)"/i;
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
      let j = pos + 1;
      while (j < line.length && /[\w_]/.test(line[j])) j++;
      if (j === pos + 1) break;
      const name = line.slice(pos + 1, j);
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
      segments.push({ name, isCall });
    }

    if (!aborted && segments.length > 0 && segments[segments.length - 1].isCall) {
      out.push({ startChar: i, endChar: pos, head, segments });
    }
    i = pos > i ? pos : i + 1;
  }
  return out;
}

/**
 * Emit zero-or-more raw call sites from a single (already cleaned) source line.
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
  const push = (hint: CallHint, expression: string) => {
    out.push({ fromSymbolId, line: lineNumber, raw: line.trim(), expression, hint });
  };

  // --- High-priority structured calls first (don't double-count their inner pattern) ---
  let m: RegExpMatchArray | null;
  if ((m = line.match(RE_EXEC_IN_SUBFORM))) {
    const form = strings[Number(m[1])];
    const method = strings[Number(m[2])];
    if (form && method) push({ kind: "ExecuteMethodInSubform", formName: form, methodName: method }, m[0]);
  }
  if ((m = line.match(RE_CALL_WORKER))) {
    const name = strings[Number(m[1])];
    if (name) push({ kind: "CallWorker", methodName: name }, m[0]);
  }
  if ((m = line.match(RE_NEW_PROCESS_STR))) {
    const name = strings[Number(m[1])];
    if (name) push({ kind: "NewProcess", methodName: name }, m[0]);
  }
  if ((m = line.match(RE_EXEC_METHOD_STR))) {
    const name = strings[Number(m[1])];
    if (name) push({ kind: "ExecuteMethodLiteral", methodName: name }, m[0]);
  }
  if ((m = line.match(RE_EXEC_METHOD_VAR))) {
    push({ kind: "ExecuteMethodDynamic", variable: m[1] }, m[0]);
  }
  if ((m = line.match(RE_FORMULA_FROM_STR))) {
    const body = strings[Number(m[1])];
    if (body) push({ kind: "Formula", body }, m[0]);
  }
  if ((m = line.match(RE_OPEN_FORM_WINDOW))) {
    const formName = strings[Number(m[1])];
    if (formName) push({ kind: "FormRef", formName }, m[0]);
  }
  if ((m = line.match(RE_DIALOG_FORM))) {
    const formName = strings[Number(m[1])];
    if (formName) push({ kind: "FormRef", formName }, m[0]);
  }
  if ((m = line.match(RE_FORM_LOAD))) {
    const formName = strings[Number(m[1])];
    if (formName) push({ kind: "FormRef", formName }, m[0]);
  }
  if ((m = line.match(RE_PRINT_FORM))) {
    const formName = strings[Number(m[1])];
    if (formName) push({ kind: "FormRef", formName }, m[0]);
  }
  if ((m = line.match(RE_MODIFY_SELECTION))) {
    const formName = strings[Number(m[1])];
    if (formName) push({ kind: "FormRef", formName }, m[0]);
  }
  if ((m = line.match(RE_DISPLAY_SELECTION))) {
    const formName = strings[Number(m[1])];
    if (formName) push({ kind: "FormRef", formName }, m[0]);
  }
  // Variable-form variants — resolve `$var` against the method's local
  // string-literal map AT THIS LINE so subsequent reassignments don't
  // retroactively change earlier call sites. Drop silently if the
  // variable hasn't been assigned a string literal yet.
  const pushFormVar = (varName: string, raw: string) => {
    const literal = localStrings?.get(varName);
    if (literal) push({ kind: "FormRef", formName: literal }, raw);
  };
  if ((m = line.match(RE_OPEN_FORM_WINDOW_VAR)))   pushFormVar(m[1], m[0]);
  if ((m = line.match(RE_DIALOG_FORM_VAR)))        pushFormVar(m[1], m[0]);
  if ((m = line.match(RE_FORM_LOAD_VAR)))          pushFormVar(m[1], m[0]);
  if ((m = line.match(RE_PRINT_FORM_VAR)))         pushFormVar(m[1], m[0]);
  if ((m = line.match(RE_MODIFY_SELECTION_VAR)))   pushFormVar(m[1], m[0]);
  if ((m = line.match(RE_DISPLAY_SELECTION_VAR)))  pushFormVar(m[1], m[0]);

  // --- cs.NS.Class.new(...) — component-class constructor ---
  // Tracked positions so the 2-segment fallback doesn't double-attribute.
  const consumedCsSpans: Array<[number, number]> = [];
  let re = new RegExp(RE_CS_NEW_NS);
  while ((m = re.exec(line))) {
    push({ kind: "CsNewNs", namespace: m[1], className: m[2] }, m[0]);
    consumedCsSpans.push([m.index!, m.index! + m[0].length]);
  }

  // --- cs.NS.Class.method(...) — component-class function ---
  re = new RegExp(RE_CS_CALL_NS);
  while ((m = re.exec(line))) {
    if (m[3] === "new") continue;
    push({ kind: "CsCallNs", namespace: m[1], className: m[2], method: m[3] }, m[0]);
    consumedCsSpans.push([m.index!, m.index! + m[0].length]);
  }

  const inConsumed = (start: number): boolean =>
    consumedCsSpans.some(([s, e]) => start >= s && start < e);

  // --- cs.X.new(...) ---
  re = new RegExp(RE_CS_NEW);
  while ((m = re.exec(line))) {
    if (inConsumed(m.index!)) continue;
    push({ kind: "CsNew", className: m[1] }, m[0]);
  }

  // --- cs.X.method(...) — but skip if it's actually cs.X.new (already captured)
  re = new RegExp(RE_CS_CALL);
  while ((m = re.exec(line))) {
    if (m[2] === "new") continue;
    if (inConsumed(m.index!)) continue;
    push({ kind: "CsCall", className: m[1], method: m[2] }, m[0]);
  }

  // --- ds.X.method(...) ---
  re = new RegExp(RE_DS_CALL);
  while ((m = re.exec(line))) {
    push({ kind: "DsCall", className: m[1], method: m[2] }, m[0]);
  }

  // --- ds[_X].new(...) and ds[_X].method(...) ---
  re = new RegExp(RE_DS_BRACKET_NEW);
  while ((m = re.exec(line))) {
    push({ kind: "DsBracketNew", ident: m[1] }, m[0]);
  }
  re = new RegExp(RE_DS_BRACKET_CALL);
  while ((m = re.exec(line))) {
    if (m[2] === "new") continue; // already handled
    push({ kind: "DsBracketCall", ident: m[1], method: m[2] }, m[0]);
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
      const prior = chain.segments.slice(0, i);
      const method = seg.name;
      if (chain.head.kind === "var") {
        if (prior.length === 0) {
          push({ kind: "VarCall", variable: chain.head.variable, method }, exprFull);
        } else {
          push({ kind: "VarChainCall", variable: chain.head.variable, path: prior, method }, exprFull);
        }
      } else {
        if (prior.length === 0) {
          push({ kind: "ThisCall", method }, exprFull);
        } else {
          push({ kind: "ThisChainCall", path: prior, method }, exprFull);
        }
      }
    }
  }

  // --- This.method(...) — fallback for plain `This.method()` not part of a
  // dotted chain. Most cases are already handled above; this regex catches
  // anything the tokenizer missed (defense in depth — overlapping matches are
  // suppressed via consumedChainSpans).
  re = new RegExp(RE_THIS_CALL);
  while ((m = re.exec(line))) {
    if (consumedChainSpans.some(([s, e]) => m!.index! >= s && m!.index! < e)) continue;
    push({ kind: "ThisCall", method: m[1] }, m[0]);
  }

  // --- Super(...) and Super.method(...) ---
  re = new RegExp(RE_SUPER);
  while ((m = re.exec(line))) {
    push({ kind: "SuperCall", method: m[1] }, m[0]);
  }

  // --- $var.method(...) — fallback for any single-step `$x.method()` call
  // that escaped the tokenizer (rare; defense in depth).
  re = new RegExp(RE_VAR_CALL);
  while ((m = re.exec(line))) {
    if (consumedChainSpans.some(([s, e]) => m!.index! >= s && m!.index! < e)) continue;
    push({ kind: "VarCall", variable: m[1], method: m[2] }, m[0]);
  }

  // --- Property assignments (set, and compound = set + get) ---
  re = new RegExp(RE_THIS_ASSIGN);
  while ((m = re.exec(line))) {
    const prop = m[1];
    const op = m[2]; // ":" for `:=`, otherwise compound op
    if (op !== ":") push({ kind: "ThisGet", property: prop }, m[0]);
    push({ kind: "ThisSet", property: prop }, m[0]);
  }
  re = new RegExp(RE_VAR_ASSIGN);
  while ((m = re.exec(line))) {
    const variable = m[1];
    const prop = m[2];
    const op = m[3];
    if (op !== ":") push({ kind: "VarGet", variable, property: prop }, m[0]);
    push({ kind: "VarSet", variable, property: prop }, m[0]);
  }
  re = new RegExp(RE_CS_ASSIGN);
  while ((m = re.exec(line))) {
    const className = m[1];
    const prop = m[2];
    const op = m[3];
    if (op !== ":") push({ kind: "CsGet", className, property: prop }, m[0]);
    push({ kind: "CsSet", className, property: prop }, m[0]);
  }

  // --- Property reads (implicit get) ---
  re = new RegExp(RE_THIS_GET);
  while ((m = re.exec(line))) {
    push({ kind: "ThisGet", property: m[1] }, m[0]);
  }
  re = new RegExp(RE_THIS_GET_CHAIN);
  while ((m = re.exec(line))) {
    push({ kind: "ThisGet", property: m[1] }, m[0]);
  }
  re = new RegExp(RE_VAR_GET);
  while ((m = re.exec(line))) {
    push({ kind: "VarGet", variable: m[1], property: m[2] }, m[0]);
  }
  re = new RegExp(RE_VAR_GET_CHAIN);
  while ((m = re.exec(line))) {
    push({ kind: "VarGet", variable: m[1], property: m[2] }, m[0]);
  }

  // --- Formula( ... ) body — capture bare names inside ---
  re = new RegExp(RE_FORMULA);
  while ((m = re.exec(line))) {
    const body = m[1];
    const inner = body.matchAll(RE_BARE_CALL);
    for (const im of inner) {
      const name = im[1];
      if (RESERVED.has(name)) continue;
      push({ kind: "BareName", name }, im[0]);
    }
    // Also detect $var.method inside formula
    const innerVar = body.matchAll(RE_VAR_CALL);
    for (const im of innerVar) {
      push({ kind: "VarCall", variable: im[1], method: im[2] }, im[0]);
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
    push({ kind: "InterprocessRef", name }, ipMatch[0]);
  }

  // --- Bare identifiers used as values (constant references) ---
  // Constants in 4D have many naming patterns:
  //   `_Rules`, `MODULE_INVOICES`, `4Q_TYPE_*`, `Worker_Backend` — single-word
  //   `Char Quote`, `Is text`, `On Load`, `Form event code` — multi-word
  // We tokenize the line into identifier words, then at each starting position
  // try matching the longest constant name (1 to 5 words) against the known
  // constants set. Words consumed by a longer match are skipped so we don't
  // double-emit (e.g. `Char Quote` shouldn't also emit `Quote` separately).
  if (constantsSet && constantsSet.size > 0) {
    // Allow digit-start tokens (e.g. `4Q_TYPE_*`) — single-word constants are
    // matched against the set as-is regardless of leading char.
    // Exclude tokens preceded by `]` so classic-record syntax `[Table]Field`
    // doesn't pick up Field as a constant (e.g. `[Goals]April`).
    const RE_WORD = /(?<![.$\w\[\]])\w+\b/g;
    const positions: Array<{ word: string; start: number; end: number }> = [];
    let wm: RegExpExecArray | null;
    while ((wm = RE_WORD.exec(line))) {
      positions.push({ word: wm[0], start: wm.index, end: wm.index + wm[0].length });
    }
    const consumed = new Array(positions.length).fill(false);
    for (let i = 0; i < positions.length; i++) {
      if (consumed[i]) continue;
      // Greedy-longest: try 5 words, then 4, then 3, …, then 1.
      let matchedLen = 0;
      let matchedName = "";
      for (let len = Math.min(5, positions.length - i); len >= 1; len--) {
        // Verify positions[i..i+len-1] are separated only by whitespace.
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
      // Reject if immediately followed by `(` — that's a method call, not a value.
      const endPos = positions[i + matchedLen - 1].end;
      const after = line.slice(endPos);
      if (/^\s*\(/.test(after)) continue;
      push({ kind: "ConstantRef", name: matchedName }, matchedName);
      for (let j = 0; j < matchedLen; j++) consumed[i + j] = true;
    }
  }

  // --- Whole-line "X Y(..." style 4D commands (e.g., HTTP Get(...) / Process 4D tags(...))
  // We run this BEFORE the bare-name pass so we can record the source-text spans
  // these matches consume; the bare pass will skip any name that falls inside.
  // Without this, `CREATE RECORD([Inventory])` produces two edges:
  //   • multi-word: "CREATE RECORD" (resolved → Builtin) — correct
  //   • bare:       "RECORD"        (Unresolved)        — bug
  const multiWordCall = /(?:^|[^A-Za-z0-9_.$])([A-Z][\w]*(?:\s+[A-Za-z][\w]*){1,4})\s*\(/g;
  let mw: RegExpMatchArray | null;
  const consumedSpans: Array<[number, number]> = [];
  while ((mw = multiWordCall.exec(line))) {
    const name = mw[1].replace(/\s+/g, " ").trim();
    if (name.length > 80) continue;
    push({ kind: "BuiltinChain", name }, mw[0]);
    // Span covers the captured name (skip the leading boundary char).
    const nameStart = mw.index! + mw[0].indexOf(mw[1]);
    consumedSpans.push([nameStart, nameStart + mw[1].length]);
  }

  // --- Parenthesis-less project method calls ---
  // 4D allows calling a parameterless project method by name alone as a
  // statement (its own line). Match a line that's nothing but an identifier
  // after the cleanLine pass strips comments/strings. The resolver maps the
  // name to a project method if one exists and drops silently otherwise —
  // we never want random identifiers becoming Unresolved symbols.
  const bareStatement = line.match(/^\s*([A-Z][\w_]+|[a-z]+[A-Z][\w_]+)\s*$/);
  if (bareStatement) {
    const name = bareStatement[1];
    if (!RESERVED.has(name)) {
      push({ kind: "ProjectMethodBare", name }, name);
    }
  }

  // --- Bare-name calls (project methods, builtins, plugins) ---
  // Avoid matching method-chain receivers like ".save(", "$x.foo(", "cs.X.fn(".
  re = new RegExp(RE_BARE_CALL);
  while ((m = re.exec(line))) {
    const name = m[1];
    if (RESERVED.has(name)) continue;
    const start = m.index! + m[0].indexOf(name);
    const prevChar = start > 0 ? line[start - 1] : "";
    if (prevChar === "." || prevChar === "$" || prevChar === ":") continue;
    // Skip if this position is already part of a recognized multi-word command —
    // e.g. the trailing "RECORD" of "CREATE RECORD(...)".
    if (consumedSpans.some(([a, b]) => start >= a && start < b)) continue;
    push({ kind: "BareName", name }, m[0]);
  }

  return out;
}
