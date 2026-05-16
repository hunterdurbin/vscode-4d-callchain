import { cleanLine, stripBlockComments } from "../util/textCleanup";

// Mirrors the regex set in fileParser.ts so on-demand completion inference
// stays in lock-step with the indexer's static capture.
const VAR_DECL = /\bvar\s+\$([\w_]+)\s*:\s*([\w.]+)/g;
const ASSIGN_NEW = /\$([\w_]+)\s*:=\s*cs\.([\w_]+)\.new\s*\(/g;
const ASSIGN_NEW_NS = /\$([\w_]+)\s*:=\s*cs\.([\w_]+)\.([\w_]+)\.new\s*\(/g;
const ASSIGN_DS_NEW = /\$([\w_]+)\s*:=\s*ds\.([\w_]+)\.(new|get)\s*\(/g;
const ASSIGN_DS_QUERY = /\$([\w_]+)\s*:=\s*ds\.([\w_]+)\.(query|all|fromCollection|orderBy|newSelection)/g;
const ASSIGN_DS_BRACKET_NEW = /\$([\w_]+)\s*:=\s*ds\s*\[\s*([\w_]+)\s*\]\s*\.\s*(new|get|first|last)\s*\(/g;
const ASSIGN_DS_BRACKET_QUERY = /\$([\w_]+)\s*:=\s*ds\s*\[\s*([\w_]+)\s*\]\s*\.\s*(query|all|fromCollection|orderBy)/g;
const DECLARE_PARAMS = /#DECLARE\s*\(([^)]*)\)/;
const FUNCTION_DECL = /^\s*(local\s+|shared\s+)?Function(\s+(get|set))?\s+[\w_]+\s*\(/i;
const CONSTRUCTOR_DECL = /^\s*Class\s+constructor\b/i;
// Legacy `C_TYPE(...)` declarations — see fileParser for the canonical
// mapping. We accept the same multi-line continuation pattern.
const C_TYPE_OPEN = /\bC_(LONGINT|INTEGER|REAL|NUMERIC|TEXT|STRING|ALPHA|BOOLEAN|DATE|TIME|BLOB|PICTURE|OBJECT|COLLECTION|POINTER|VARIANT)\s*\(/i;

function canonicalCType(type: string): string | undefined {
  const t = type.toUpperCase();
  switch (t) {
    case "LONGINT": case "INTEGER": case "REAL": case "NUMERIC": return "Number";
    case "TEXT": case "STRING": case "ALPHA": return "Text";
    case "BOOLEAN": return "Boolean";
    case "DATE": return "Date";
    case "TIME": return "Time";
    case "BLOB": return "Blob";
    case "PICTURE": return "Picture";
    case "OBJECT": return "Object";
    case "COLLECTION": return "Collection";
    default: return undefined;
  }
}

function parenBalance(s: string): number {
  let n = 0;
  for (const c of s) {
    if (c === "(") n++;
    else if (c === ")") n--;
  }
  return n;
}

/**
 * Find the line range of the function / constructor / file-level scope that
 * contains `cursorLine`. Returns `{ startLine, endLine }` (inclusive).
 *
 * Class files: scopes are `Function …` and `Class constructor` declarations.
 * Project methods: the whole file is one scope.
 */
export function findEnclosingFunction(source: string, cursorLine: number): { startLine: number; endLine: number } {
  const lines = stripBlockComments(source).split(/\r?\n/);
  let startLine = 0;
  for (let i = Math.min(cursorLine, lines.length - 1); i >= 0; i--) {
    if (FUNCTION_DECL.test(lines[i]) || CONSTRUCTOR_DECL.test(lines[i])) {
      startLine = i;
      break;
    }
  }
  let endLine = lines.length - 1;
  for (let i = startLine + 1; i < lines.length; i++) {
    if (FUNCTION_DECL.test(lines[i]) || CONSTRUCTOR_DECL.test(lines[i])) {
      endLine = i - 1;
      break;
    }
  }
  return { startLine, endLine };
}

/**
 * Walk a source range and infer `$var → type` mappings using the same patterns
 * the indexer applies offline. Intended for completion-time use where the
 * on-disk index is stale (the user is mid-edit).
 *
 * Output type strings are the same tokens fileParser emits (`cs.Foo`,
 * `cs.NS.Bar`, `dsTable:Table`, `dsTableSelection:Table`,
 * `entitySelectionOf:Table`, raw primitive names like `Text`).
 */
export function inferLocals(source: string, startLine: number, endLine: number): Map<string, string> {
  const out = new Map<string, string>();
  const lines = source.split(/\r?\n/);
  const sliceStart = Math.max(0, startLine);
  const sliceEnd = Math.min(lines.length - 1, endLine);

  // Function signature: capture params on the declaration line itself.
  const declLine = lines[sliceStart] ?? "";
  if (FUNCTION_DECL.test(declLine) || CONSTRUCTOR_DECL.test(declLine)) {
    const openParen = declLine.indexOf("(");
    if (openParen !== -1) {
      const closeParen = declLine.indexOf(")", openParen);
      const paramText = closeParen !== -1 ? declLine.slice(openParen + 1, closeParen) : declLine.slice(openParen + 1);
      for (const part of paramText.split(";")) {
        const m = part.match(/\$([\w_]+)\s*:\s*([\w.]+)/);
        if (m) out.set(m[1], m[2]);
      }
    }
  }

  for (let i = sliceStart; i <= sliceEnd; i++) {
    const { text: line } = cleanLine(lines[i] ?? "");

    // Legacy C_<TYPE>($a; $b; ...) — possibly continued across lines.
    const cOpen = line.match(C_TYPE_OPEN);
    if (cOpen) {
      const canon = canonicalCType(cOpen[1]);
      let buf = line;
      let j = i + 1;
      while (parenBalance(buf) > 0 && j <= sliceEnd) {
        buf += " " + cleanLine(lines[j] ?? "").text;
        j++;
      }
      if (canon) {
        const block = buf.match(/\bC_\w+\s*\(([^)]*)\)/i);
        if (block) {
          for (const part of block[1].split(/[;,]/)) {
            const vm = part.match(/\$([\w_]+)/);
            if (vm) out.set(vm[1], canon);
          }
        }
      }
    }

    let m: RegExpExecArray | null;
    VAR_DECL.lastIndex = 0;
    while ((m = VAR_DECL.exec(line))) out.set(m[1], m[2]);

    ASSIGN_NEW_NS.lastIndex = 0;
    while ((m = ASSIGN_NEW_NS.exec(line))) out.set(m[1], `cs.${m[2]}.${m[3]}`);

    ASSIGN_NEW.lastIndex = 0;
    while ((m = ASSIGN_NEW.exec(line))) {
      if (!out.has(m[1])) out.set(m[1], `cs.${m[2]}`);
    }

    ASSIGN_DS_NEW.lastIndex = 0;
    while ((m = ASSIGN_DS_NEW.exec(line))) out.set(m[1], `dsTable:${m[2]}`);

    ASSIGN_DS_QUERY.lastIndex = 0;
    while ((m = ASSIGN_DS_QUERY.exec(line))) out.set(m[1], `entitySelectionOf:${m[2]}`);

    ASSIGN_DS_BRACKET_NEW.lastIndex = 0;
    while ((m = ASSIGN_DS_BRACKET_NEW.exec(line))) {
      const tbl = m[2].replace(/^_/, "");
      out.set(m[1], `dsTable:${tbl}`);
    }

    ASSIGN_DS_BRACKET_QUERY.lastIndex = 0;
    while ((m = ASSIGN_DS_BRACKET_QUERY.exec(line))) {
      const tbl = m[2].replace(/^_/, "");
      out.set(m[1], `dsTableSelection:${tbl}`);
    }

    const dec = line.match(DECLARE_PARAMS);
    if (dec) {
      for (const part of dec[1].split(";")) {
        const pm = part.match(/\$([\w_]+)\s*:\s*([\w.]+)/);
        if (pm) out.set(pm[1], pm[2]);
      }
    }
  }
  return out;
}

/**
 * Normalize a raw type token (as captured by `inferLocals` or the indexer)
 * into one of the canonical forms used downstream:
 *   - `cs.<NS>.<Class>` (component class)
 *   - `<ProjectClass>` (project class name)
 *   - `EntitySelection<<Class>>` (parametric ORDA selection)
 *   - `Collection`, `Object`, `Date`, `Time`, `Number`, `Text`, `Boolean`,
 *     `Picture`, `Blob`, `Formula` (canonical primitives/containers)
 *   - `Entity<<Class>>` for explicit ORDA entity
 *
 * `tableToEntityClass` translates a 4D table name into the user-defined
 * Entity class name (returns the table name unchanged if no mapping known).
 */
export function normalizeLocalType(
  type: string | undefined,
  tableToEntityClass?: (tbl: string) => string | undefined
): string | undefined {
  if (!type) return undefined;
  if (/^cs\.[\w_]+\.[\w_]+$/.test(type)) return type;
  const csMatch = type.match(/^cs\.([\w_]+)$/);
  if (csMatch) return csMatch[1];
  const esMatch = type.match(/^entitySelectionOf:([\w_]+)$/) ?? type.match(/^dsTableSelection:([\w_]+)$/);
  if (esMatch) {
    const cls = tableToEntityClass?.(esMatch[1]) ?? esMatch[1];
    return `EntitySelection<${cls}>`;
  }
  const dsTable = type.match(/^dsTable:([\w_]+)$/);
  if (dsTable) {
    return tableToEntityClass?.(dsTable[1]) ?? dsTable[1];
  }
  if (/^EntitySelection<[\w_]+>$/.test(type)) return type;
  // Project class: caller checks against the symbol index — return bare name.
  // Primitive 4D types → canonical bases that BUILTIN_TYPE_API keys on.
  const primMap: Record<string, string> = {
    Integer: "Number", Longint: "Number", Real: "Number", Numeric: "Number", Number: "Number",
    Alpha: "Text", Text: "Text", String: "Text",
    Boolean: "Boolean", Bool: "Boolean",
    Date: "Date", Time: "Time",
    Collection: "Collection", Object: "Object",
    Picture: "Picture", Blob: "Blob", Formula: "Formula"
  };
  if (primMap[type]) return primMap[type];
  return type;
}
