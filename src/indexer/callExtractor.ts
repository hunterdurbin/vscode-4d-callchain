import { CallHint, RawCallSite } from "../model/symbol";

// --- Patterns (run against a comment/string-stripped line) ---
const RE_CALL_WORKER     = /\bCALL\s+WORKER\b\s*\([^"]*?;\s*"(\d+)"/i;
const RE_NEW_PROCESS_STR = /\bNew\s+process\s*\(\s*"(\d+)"/i;
const RE_EXEC_METHOD_STR = /\bEXECUTE\s+METHOD\s*\(\s*"(\d+)"/i;
const RE_EXEC_METHOD_VAR = /\bEXECUTE\s+METHOD\s*\(\s*\$([\w_]+)/i;
const RE_EXEC_IN_SUBFORM = /\bEXECUTE\s+METHOD\s+IN\s+SUBFORM\s*\(\s*"(\d+)"\s*;\s*"(\d+)"/i;
const RE_FORMULA_FROM_STR= /\bFormula\s+from\s+string\s*\(\s*"(\d+)"/i;
const RE_PROCESS_4D_TAGS = /\bProcess\s+4D\s+tags\s*\(/i;

// Static identifier-based patterns
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

// --- Property-access patterns (computed getters / setters) ---
// Assignment forms: `:=` is plain set; `+=`/`-=`/`*=`/`/=` is compound (read + write).
// We capture both `:=` and compound, then post-process to emit get+set for compound.
const RE_THIS_ASSIGN  = /\bThis\.([\w_]+)\s*(:|[+\-*/])=(?!=)/g;
const RE_VAR_ASSIGN   = /(?<![.\w])\$([\w_]+)\.([\w_]+)\s*(:|[+\-*/])=(?!=)/g;
const RE_CS_ASSIGN    = /\bcs\.([\w_]+)\.([\w_]+)\s*(:|[+\-*/])=(?!=)/g;

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
  "ORDER","SELECT","SHOW","HIDE","COPY","MOVE","TRACE","ALERT",
  "CONFIRM","REQUEST","BEEP","PAUSE","ABORT","DIALOG","Choose",
  "Sum","Min","Max","Count","Average",
  // Form constants commonly called like functions in some legacy code:
  "Form","FORM"
]);

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
  constantsSet?: Set<string>
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

  // --- cs.X.new(...) ---
  let re = new RegExp(RE_CS_NEW);
  while ((m = re.exec(line))) {
    push({ kind: "CsNew", className: m[1] }, m[0]);
  }

  // --- cs.X.method(...) — but skip if it's actually cs.X.new (already captured)
  re = new RegExp(RE_CS_CALL);
  while ((m = re.exec(line))) {
    if (m[2] === "new") continue;
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

  // --- This.method(...) ---
  re = new RegExp(RE_THIS_CALL);
  while ((m = re.exec(line))) {
    push({ kind: "ThisCall", method: m[1] }, m[0]);
  }

  // --- Super(...) and Super.method(...) ---
  re = new RegExp(RE_SUPER);
  while ((m = re.exec(line))) {
    push({ kind: "SuperCall", method: m[1] }, m[0]);
  }

  // --- $var.method(...) ---
  re = new RegExp(RE_VAR_CALL);
  while ((m = re.exec(line))) {
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

  // --- Bare identifiers used as values (constant references) ---
  // Constants in 4D have many naming patterns (`_Rules`, `MODULE_INVOICES`,
  // `4Q_TYPE_*`, `Worker_Backend`, ...). We match any bare identifier that
  // isn't preceded by `.` / `$` / `[` / word char (which would mean it's
  // already part of `cs.X`, `$x`, `ds[X]`, or a longer name) and isn't
  // followed by `(` (which would make it a method call). Then we filter
  // inline against the known-constants set so non-constant identifiers
  // (locals, parameters, keywords) are dropped without producing hints.
  if (constantsSet && constantsSet.size > 0) {
    const RE_BARE_IDENT = /(?<![.$\w\[])\w+\b/g;
    let bareIdentMatch: RegExpExecArray | null;
    while ((bareIdentMatch = RE_BARE_IDENT.exec(line))) {
      const name = bareIdentMatch[0];
      if (!constantsSet.has(name)) continue;
      const after = line.slice(bareIdentMatch.index + name.length);
      if (/^\s*\(/.test(after)) continue; // method call, not a constant ref
      push({ kind: "ConstantRef", name }, name);
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
