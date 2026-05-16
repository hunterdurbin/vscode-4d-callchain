import {
  Connection,
  SemanticTokens,
  SemanticTokensLegend,
  SemanticTokensParams,
  SemanticTokensRangeParams,
  Range
} from "vscode-languageserver/node";
import { CallEdge, SymbolKind, SymbolRecord } from "@4d/core";
import { ServerState } from "../state";

// Stable ordering — clients see indices into these arrays.
const TOKEN_TYPES = [
  "function",   // 0
  "method",     // 1
  "class",      // 2
  "property",   // 3
  "parameter",  // 4
  "variable",   // 5
  "keyword",    // 6
  "comment",    // 7
  "string",     // 8
  "number",     // 9
  "macro"       // 10
] as const;

const TOKEN_MODIFIERS = [
  "defaultLibrary", // bit 0 — 4D builtins, plugin commands
  "deprecated",     // bit 1 — reserved
  "static"          // bit 2 — component-namespace methods
] as const;

const TYPE_FUNCTION  = 0;
const TYPE_METHOD    = 1;
const TYPE_CLASS     = 2;
const TYPE_PROPERTY  = 3;
const TYPE_MACRO     = 10;

const MOD_DEFAULT_LIBRARY = 1 << 0;
const MOD_STATIC = 1 << 2;

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
  connection: Connection
): void {
  connection.languages.semanticTokens.on((params: SemanticTokensParams): SemanticTokens => {
    return { data: encode(buildTokens(state, params.textDocument.uri)) };
  });
  connection.languages.semanticTokens.onRange((params: SemanticTokensRangeParams): SemanticTokens => {
    const all = buildTokens(state, params.textDocument.uri);
    const r = params.range;
    const inRange = all.filter((t) => {
      const beforeEnd = t.line < r.end.line || (t.line === r.end.line && t.startChar <= r.end.character);
      const afterStart = t.line > r.start.line || (t.line === r.start.line && t.startChar + t.length >= r.start.character);
      return beforeEnd && afterStart;
    });
    return { data: encode(inRange) };
  });
}

function buildTokens(state: ServerState, uri: string): Token[] {
  const graph = state.graph;
  if (!graph) return [];
  const tokens: Token[] = [];

  // 1. Symbol definitions in this file (function names, class headers, getters).
  for (const sym of graph.allSymbols()) {
    if (sym.location.uri !== uri) continue;
    if (sym.location.column === undefined) continue;
    const t = symbolToken(sym, sym.location.line, sym.location.column, sym.location.endColumn);
    if (t) tokens.push(t);
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
      if (t) tokens.push(t);
    }
  }

  // Sort by (line, startChar). Required by the LSP encoded delta format.
  tokens.sort((a, b) => a.line - b.line || a.startChar - b.startChar);

  // Drop overlaps — definition tokens win over call-site tokens at the same
  // position (e.g. a self-recursive call).
  const out: Token[] = [];
  let last: Token | undefined;
  for (const t of tokens) {
    if (last && last.line === t.line && last.startChar === t.startChar && last.length === t.length) continue;
    out.push(t);
    last = t;
  }
  return out;
}

function symbolToken(sym: SymbolRecord, line: number, startChar: number, endChar?: number): Token | undefined {
  const length = (endChar ?? startChar) - startChar;
  if (length <= 0) return undefined;
  switch (sym.kind) {
    case SymbolKind.Class:
      return { line, startChar, length, typeIdx: TYPE_CLASS, modifiers: 0 };
    case SymbolKind.ClassFunction:
    case SymbolKind.ClassConstructor:
      return { line, startChar, length, typeIdx: TYPE_METHOD, modifiers: 0 };
    case SymbolKind.ClassGetter:
    case SymbolKind.ClassSetter:
      return { line, startChar, length, typeIdx: TYPE_PROPERTY, modifiers: 0 };
    case SymbolKind.ProjectMethod:
    case SymbolKind.DatabaseMethod:
    case SymbolKind.CompilerMethod:
      return { line, startChar, length, typeIdx: TYPE_FUNCTION, modifiers: 0 };
    case SymbolKind.Constant:
    case SymbolKind.BuiltinConstant:
      return { line, startChar, length, typeIdx: TYPE_MACRO, modifiers: 0 };
    default:
      return undefined;
  }
}

function callSiteToken(edge: CallEdge, target: SymbolRecord | undefined, length: number): Token | undefined {
  const startChar = edge.column!;
  const line = edge.line;
  if (!target) {
    // Unresolved — guess from the raw call shape.
    return { line, startChar, length, typeIdx: TYPE_METHOD, modifiers: 0 };
  }
  let typeIdx: number;
  let modifiers = 0;
  switch (target.kind) {
    case SymbolKind.Class:
      typeIdx = TYPE_CLASS;
      break;
    case SymbolKind.ClassFunction:
    case SymbolKind.ClassConstructor:
      typeIdx = TYPE_METHOD;
      break;
    case SymbolKind.ClassGetter:
    case SymbolKind.ClassSetter:
      typeIdx = TYPE_PROPERTY;
      break;
    case SymbolKind.ProjectMethod:
    case SymbolKind.DatabaseMethod:
    case SymbolKind.CompilerMethod:
      typeIdx = TYPE_FUNCTION;
      break;
    case SymbolKind.Builtin:
    case SymbolKind.TableBuiltin:
      typeIdx = TYPE_FUNCTION;
      modifiers |= MOD_DEFAULT_LIBRARY;
      break;
    case SymbolKind.PluginCommand:
      typeIdx = TYPE_FUNCTION;
      modifiers |= MOD_DEFAULT_LIBRARY;
      break;
    case SymbolKind.ComponentMethod:
      typeIdx = TYPE_METHOD;
      modifiers |= MOD_STATIC;
      break;
    case SymbolKind.Constant:
    case SymbolKind.BuiltinConstant:
      typeIdx = TYPE_MACRO;
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
