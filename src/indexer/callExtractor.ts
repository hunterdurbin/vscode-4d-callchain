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
const RE_THIS_CALL= /\bThis\.([\w_]+)\s*\(/g;
const RE_SUPER    = /\bSuper(?:\.([\w_]+))?\s*\(/g;
const RE_VAR_CALL = /\$([\w_]+)\.([\w_]+)\s*\(/g;

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
 */
export function extractCallSitesFromLine(
  line: string,
  strings: string[],
  fromSymbolId: string,
  lineNumber: number
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

  // --- Bare-name calls (project methods, builtins, plugins) ---
  // We need to avoid matching method-chain receivers like ".save(", "$x.foo(", "cs.X.fn(".
  re = new RegExp(RE_BARE_CALL);
  while ((m = re.exec(line))) {
    const name = m[1];
    if (RESERVED.has(name)) continue;
    // Skip if preceded by '.' or '$' or ':'
    const start = m.index! + m[0].indexOf(name);
    const prevChar = start > 0 ? line[start - 1] : "";
    if (prevChar === "." || prevChar === "$" || prevChar === ":") continue;
    push({ kind: "BareName", name }, m[0]);
  }

  // --- Whole-line "X Y(..." style 4D commands (e.g., HTTP Get(...) / Process 4D tags(...)) ---
  // We capture command-like sequences of "Word Word..." preceding "(" so the resolver can
  // try them against the builtin set.
  const multiWordCall = /(?:^|[^A-Za-z0-9_.$])([A-Z][\w]*(?:\s+[A-Za-z][\w]*){1,4})\s*\(/g;
  let mw: RegExpMatchArray | null;
  while ((mw = multiWordCall.exec(line))) {
    const name = mw[1].replace(/\s+/g, " ").trim();
    if (name.length > 80) continue;
    push({ kind: "BuiltinChain", name }, mw[0]);
  }

  return out;
}
