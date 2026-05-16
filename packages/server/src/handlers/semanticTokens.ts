import {
  Connection,
  SemanticTokens,
  SemanticTokensLegend,
  SemanticTokensParams,
  SemanticTokensRangeParams,
  Range,
  TextDocuments
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { CallEdge, LexToken, LexTokenKind, SymbolKind, SymbolRecord, tokenize } from "@4d/core";
import { ServerState } from "../state";

// Stable ordering — clients see indices into these arrays. Token type names
// and modifiers mirror the official 4D VS Code extension convention
// (https://blog.4d.com/setting-up-code-syntax-highlighting-using-the-visual-studio-code-extension/)
// so stock themes and 4D-specific themes both light up correctly:
//   • method                 → project methods
//   • method.defaultLibrary  → 4D builtins (commands)
//   • method.plugin          → plugin commands
//   • method.static          → component-namespace methods (kept from 4D's
//                              convention of qualifying static-style calls)
//   • function               → class member functions (object member functions)
//   • property               → class getters/setters & dot-access reads/writes
//   • parameter              → method parameters ($1..$N, named params)
//   • variable.local         → $local variables
//   • variable.process       → declared process variables
//   • variable.interprocess  → declared <>interprocess variables
//   • table / field          → [Table] / [Table]Field references
//   • type                   → class names
//   • constant               → 4D builtin constants + project constants
const TOKEN_TYPES = [
  "method",     // 0
  "property",   // 1
  "function",   // 2
  "parameter",  // 3
  "variable",   // 4
  "keyword",    // 5
  "table",      // 6
  "field",      // 7
  "comment",    // 8
  "type",       // 9
  "constant",   // 10
  "string",     // 11
  "number",     // 12
  "operator",   // 13 — `( ) { } ; , + - * / = # < > <= >= := : . & | ^ ->`
  "error"       // 14
] as const;

const TOKEN_MODIFIERS = [
  "defaultLibrary", // bit 0 — 4D builtins
  "deprecated",     // bit 1 — reserved
  "static",         // bit 2 — component-namespace methods (method.static)
  "plugin",         // bit 3 — plugin commands (method.plugin)
  "interprocess",   // bit 4 — variable.interprocess
  "process",        // bit 5 — variable.process
  "local"           // bit 6 — variable.local
] as const;

const TYPE_METHOD    = 0;
const TYPE_PROPERTY  = 1;
const TYPE_FUNCTION  = 2;
const TYPE_PARAMETER = 3;
const TYPE_VARIABLE  = 4;
const TYPE_KEYWORD   = 5;
const TYPE_TABLE     = 6;
const TYPE_FIELD     = 7;
const TYPE_COMMENT   = 8;
const TYPE_TYPE      = 9;
const TYPE_CONSTANT  = 10;
const TYPE_STRING    = 11;
const TYPE_NUMBER    = 12;
const TYPE_OPERATOR  = 13;
const TYPE_ERROR     = 14;

const MOD_DEFAULT_LIBRARY = 1 << 0;
const MOD_STATIC          = 1 << 2;
const MOD_PLUGIN          = 1 << 3;
const MOD_INTERPROCESS    = 1 << 4;
const MOD_PROCESS         = 1 << 5;
const MOD_LOCAL           = 1 << 6;

// `TYPE_ERROR` is reserved for future unresolved/error decoration.
void TYPE_ERROR;

export const SEMANTIC_TOKENS_LEGEND: SemanticTokensLegend = {
  tokenTypes: [...TOKEN_TYPES],
  tokenModifiers: [...TOKEN_MODIFIERS]
};

interface Token {
  line: number;
  startChar: number;
  length: number;
  typeIdx: number;
  modifiers: number;
}

export function registerSemanticTokensHandler(
  state: ServerState,
  connection: Connection,
  documents: TextDocuments<TextDocument>
): void {
  connection.languages.semanticTokens.on((params: SemanticTokensParams): SemanticTokens => {
    return { data: encode(buildTokens(state, documents, params.textDocument.uri)) };
  });
  connection.languages.semanticTokens.onRange((params: SemanticTokensRangeParams): SemanticTokens => {
    const all = buildTokens(state, documents, params.textDocument.uri);
    const r = params.range;
    const inRange = all.filter((t) => {
      const beforeEnd = t.line < r.end.line || (t.line === r.end.line && t.startChar <= r.end.character);
      const afterStart = t.line > r.start.line || (t.line === r.start.line && t.startChar + t.length >= r.start.character);
      return beforeEnd && afterStart;
    });
    return { data: encode(inRange) };
  });
}

function buildTokens(
  state: ServerState,
  documents: TextDocuments<TextDocument>,
  uri: string
): Token[] {
  const graph = state.graph;
  const symbolTokens: Token[] = [];

  if (graph) {
    // 1. Symbol definitions in this file (function names, class headers, getters).
    for (const sym of graph.allSymbols()) {
      if (sym.location.uri !== uri) continue;
      if (sym.location.column === undefined) continue;
      const t = symbolToken(sym, sym.location.line, sym.location.column, sym.location.endColumn);
      if (t) symbolTokens.push(t);
    }

    // 2. Call sites — the callee identifier at the call expression's location.
    for (const sym of graph.allSymbols()) {
      if (sym.location.uri !== uri) continue;
      for (const edge of graph.callees(sym.id)) {
        if (edge.column === undefined) continue;
        const length = (edge.endColumn ?? edge.column) - edge.column;
        if (length <= 0) continue;
        const target = graph.symbol(edge.toId);
        const t = callSiteToken(edge, target, length);
        if (t) symbolTokens.push(t);
      }
    }
  }

  // 3. Lexical pass — keywords, strings, numbers, comments, $locals, $params,
  // <>ipvars, process variables. Symbol-aware tokens win on overlap (they
  // know `Length` is a builtin; the lexer only sees an identifier).
  const lexTokens: Token[] = [];
  const doc = documents.get(uri);
  if (doc) {
    const processVariables = collectVariableNames(state);
    const lex = tokenize(doc.getText(), { processVariables });
    const claimed = buildClaimedSpans(symbolTokens);
    for (const lt of lex) {
      const t = lexTokenToToken(lt);
      if (!t) continue;
      if (overlapsClaimed(claimed, t)) continue;
      lexTokens.push(t);
    }
  }

  const tokens = [...symbolTokens, ...lexTokens];

  // Sort by (line, startChar). Required by the LSP encoded delta format.
  tokens.sort((a, b) => a.line - b.line || a.startChar - b.startChar);

  // Drop exact-duplicate spans (e.g. self-recursive calls where a def and a
  // call site land at the same position).
  const out: Token[] = [];
  let last: Token | undefined;
  for (const t of tokens) {
    if (last && last.line === t.line && last.startChar === t.startChar && last.length === t.length) continue;
    out.push(t);
    last = t;
  }
  return out;
}

function lexTokenToToken(lt: LexToken): Token | undefined {
  if (lt.length <= 0) return undefined;
  const mapped = LEX_KIND_TO_TOKEN[lt.kind];
  if (!mapped) return undefined;
  return {
    line: lt.line,
    startChar: lt.startChar,
    length: lt.length,
    typeIdx: mapped.typeIdx,
    modifiers: mapped.modifiers
  };
}

// Lex kind → (type, modifiers).
//
// Every lex kind that lights up a recognizable visual class is emitted so that
// stock themes (which usually color the STANDARD semantic-token types and the
// matching TextMate scopes) have something to bind to. The TextMate grammar's
// fine-grained `.4d` scopes still flow through too — themes that target them
// win on specificity, while themes that don't fall back to the standard
// semantic scopes via `contributes.semanticTokenScopes`.
const LEX_KIND_TO_TOKEN: Partial<Record<LexTokenKind, { typeIdx: number; modifiers: number }>> = {
  keyword:         { typeIdx: TYPE_KEYWORD,   modifiers: 0 },
  string:          { typeIdx: TYPE_STRING,    modifiers: 0 },
  number:          { typeIdx: TYPE_NUMBER,    modifiers: 0 },
  comment:         { typeIdx: TYPE_COMMENT,   modifiers: 0 },
  localVar:        { typeIdx: TYPE_VARIABLE,  modifiers: MOD_LOCAL },
  parameter:       { typeIdx: TYPE_PARAMETER, modifiers: 0 },
  interprocessVar: { typeIdx: TYPE_VARIABLE,  modifiers: MOD_INTERPROCESS },
  processVar:      { typeIdx: TYPE_VARIABLE,  modifiers: MOD_PROCESS },
  tableRef:        { typeIdx: TYPE_TABLE,     modifiers: 0 },
  fieldRef:        { typeIdx: TYPE_FIELD,     modifiers: 0 },
  type:            { typeIdx: TYPE_TYPE,      modifiers: 0 },
  operator:        { typeIdx: TYPE_OPERATOR,  modifiers: 0 },
  builtinGlobal:   { typeIdx: TYPE_METHOD,    modifiers: MOD_DEFAULT_LIBRARY },
  builtinCommand:  { typeIdx: TYPE_METHOD,    modifiers: MOD_DEFAULT_LIBRARY },
  property:        { typeIdx: TYPE_PROPERTY,  modifiers: 0 }
};

/**
 * Build the case-folded set of process / interprocess variable names from the
 * current index. Lexer uses this to color bare-identifier usages of declared
 * variables. Empty set when no graph is loaded yet.
 */
function collectVariableNames(state: ServerState): Set<string> {
  const out = new Set<string>();
  const graph = state.graph;
  if (!graph) return out;
  for (const sym of graph.allSymbols()) {
    if (sym.kind === SymbolKind.ProcessVariable || sym.kind === SymbolKind.InterprocessVariable) {
      out.add(sym.name.toLowerCase());
    }
  }
  return out;
}

/**
 * Build a per-line index of claimed character ranges from the symbol-aware
 * tokens. Used to drop lex tokens that overlap a higher-fidelity symbol token.
 */
function buildClaimedSpans(symbolTokens: Token[]): Map<number, Array<[number, number]>> {
  const map = new Map<number, Array<[number, number]>>();
  for (const t of symbolTokens) {
    const arr = map.get(t.line) ?? [];
    arr.push([t.startChar, t.startChar + t.length]);
    map.set(t.line, arr);
  }
  return map;
}

function overlapsClaimed(
  claimed: Map<number, Array<[number, number]>>,
  t: Token
): boolean {
  const spans = claimed.get(t.line);
  if (!spans) return false;
  const a = t.startChar;
  const b = t.startChar + t.length;
  for (const [s, e] of spans) {
    if (a < e && s < b) return true;
  }
  return false;
}

function symbolToken(sym: SymbolRecord, line: number, startChar: number, endChar?: number): Token | undefined {
  const length = (endChar ?? startChar) - startChar;
  if (length <= 0) return undefined;
  switch (sym.kind) {
    case SymbolKind.Class:
      return { line, startChar, length, typeIdx: TYPE_TYPE, modifiers: 0 };
    case SymbolKind.ClassFunction:
    case SymbolKind.ClassConstructor:
      return { line, startChar, length, typeIdx: TYPE_FUNCTION, modifiers: 0 };
    case SymbolKind.ClassGetter:
    case SymbolKind.ClassSetter:
      return { line, startChar, length, typeIdx: TYPE_PROPERTY, modifiers: 0 };
    case SymbolKind.ProjectMethod:
    case SymbolKind.DatabaseMethod:
    case SymbolKind.CompilerMethod:
      return { line, startChar, length, typeIdx: TYPE_METHOD, modifiers: 0 };
    case SymbolKind.Constant:
    case SymbolKind.BuiltinConstant:
      return { line, startChar, length, typeIdx: TYPE_CONSTANT, modifiers: 0 };
    case SymbolKind.ProcessVariable:
      return { line, startChar, length, typeIdx: TYPE_VARIABLE, modifiers: MOD_PROCESS };
    case SymbolKind.InterprocessVariable:
      return { line, startChar, length, typeIdx: TYPE_VARIABLE, modifiers: MOD_INTERPROCESS };
    default:
      return undefined;
  }
}

function callSiteToken(edge: CallEdge, target: SymbolRecord | undefined, length: number): Token | undefined {
  const startChar = edge.column!;
  const line = edge.line;
  if (!target) {
    // Unresolved — guess from the raw call shape (most are project-method
    // candidates by syntax). Themes that distinguish errors can opt in by
    // also styling `error`; we don't tag unresolved here because that's
    // diagnostic territory, not lexical.
    return { line, startChar, length, typeIdx: TYPE_METHOD, modifiers: 0 };
  }
  let typeIdx: number;
  let modifiers = 0;
  switch (target.kind) {
    case SymbolKind.Class:
      typeIdx = TYPE_TYPE;
      break;
    case SymbolKind.ClassFunction:
    case SymbolKind.ClassConstructor:
      typeIdx = TYPE_FUNCTION;
      break;
    case SymbolKind.ClassGetter:
    case SymbolKind.ClassSetter:
      typeIdx = TYPE_PROPERTY;
      break;
    case SymbolKind.ProjectMethod:
    case SymbolKind.DatabaseMethod:
    case SymbolKind.CompilerMethod:
      typeIdx = TYPE_METHOD;
      break;
    case SymbolKind.Builtin:
    case SymbolKind.TableBuiltin:
      typeIdx = TYPE_METHOD;
      modifiers |= MOD_DEFAULT_LIBRARY;
      break;
    case SymbolKind.PluginCommand:
      typeIdx = TYPE_METHOD;
      modifiers |= MOD_PLUGIN;
      break;
    case SymbolKind.ComponentMethod:
      typeIdx = TYPE_METHOD;
      modifiers |= MOD_STATIC;
      break;
    case SymbolKind.Constant:
    case SymbolKind.BuiltinConstant:
      typeIdx = TYPE_CONSTANT;
      break;
    case SymbolKind.ProcessVariable:
      typeIdx = TYPE_VARIABLE;
      modifiers |= MOD_PROCESS;
      break;
    case SymbolKind.InterprocessVariable:
      typeIdx = TYPE_VARIABLE;
      modifiers |= MOD_INTERPROCESS;
      break;
    case SymbolKind.Unresolved:
      typeIdx = TYPE_METHOD;
      break;
    default:
      return undefined;
  }
  return { line, startChar, length, typeIdx, modifiers };
}

/**
 * Encode tokens in the LSP delta format: 5 ints per token —
 * deltaLine, deltaStart (relative to previous token's startChar when on the
 * same line; absolute otherwise), length, tokenType, tokenModifiers.
 */
function encode(tokens: Token[]): number[] {
  const out: number[] = [];
  let prevLine = 0;
  let prevStart = 0;
  for (const t of tokens) {
    const deltaLine = t.line - prevLine;
    const deltaStart = deltaLine === 0 ? t.startChar - prevStart : t.startChar;
    out.push(deltaLine, deltaStart, t.length, t.typeIdx, t.modifiers);
    prevLine = t.line;
    prevStart = t.startChar;
  }
  return out;
}

// Silence unused-import warning (kept available for callers who want the type).
void Range;
