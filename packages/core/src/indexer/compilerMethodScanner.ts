/**
 * Compiler_*.4dm method-parameter-type scanner.
 *
 * 4D's "Update Compiler Variables" tool generates files named
 * `Compiler_*.4dm` under `Project/Sources/Methods/` that list every project
 * method's parameter types using legacy `C_<TYPE>(...)` declarations:
 *
 *   C_LONGINT(Math_Minimum; $0)     ← return type
 *   C_LONGINT(Math_Minimum; $1)     ← first arg
 *   C_LONGINT(Math_Minimum; ${1})   ← variadic LONGINT from $1 onward
 *   C_POINTER(Array_Display; ${2})  ← variadic POINTER from $2 (first arg is
 *                                     fixed, declared elsewhere)
 *
 * The `${N}` notation means "zero-or-more args of this type starting at
 * position N." 4D's own `#DECLARE` syntax does not currently express this —
 * variadic methods rely entirely on the Compiler_* declaration. (See TODO
 * #24 for a future #DECLARE syntax extension that would make this redundant.)
 *
 * This scanner returns a map of method name → parameter-type info so the
 * indexer can augment the method's `SymbolRecord.params[]`. Mixed fixed +
 * variadic is supported: separate `C_TYPE(method; $1)` and
 * `C_OTHER(method; ${2})` declarations combine into a method with one fixed
 * arg followed by a variadic tail.
 */

import * as fs from "fs";
import * as path from "path";

export interface CompilerMethodTypes {
  /** Project method name (case-preserving — first-seen casing wins). */
  name: string;
  /** Return type from `C_TYPE(method; $0)`, if declared. */
  returnType?: string;
  /** Fixed parameter types, keyed by 1-based position. */
  paramTypes: Map<number, string>;
  /** 1-based position at which variadic args start (from `${N}` notation). */
  variadicFrom?: number;
  /** Type of every variadic arg. */
  variadicType?: string;
}

// Match `C_TYPE(MethodName; $N)` or `C_TYPE(MethodName; ${N})`. Whitespace
// between tokens is permissive; `//` trailing comments are tolerated by
// pre-stripping. The capture groups are:
//   [1] type word (LONGINT, TEXT, REAL, ...)
//   [2] method name
//   [3] position number
//   [4] truthy when the position was wrapped in `{}` (variadic marker)
const RE_METHOD_PARAM_DECL =
  /^\s*C_([A-Z]+)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*;\s*\$(\{)?(\d+)\}?\s*\)/;

// Same type map as the variableScanner uses — keep in sync with 4D's
// canonical-type spellings.
const TYPE_NAMES_C: Record<string, string> = {
  LONGINT: "Longint",
  INTEGER: "Integer",
  REAL: "Real",
  TEXT: "Text",
  STRING: "Text",
  BOOLEAN: "Boolean",
  DATE: "Date",
  TIME: "Time",
  BLOB: "Blob",
  PICTURE: "Picture",
  POINTER: "Pointer",
  OBJECT: "Object",
  COLLECTION: "Collection",
  VARIANT: "Variant",
};

/**
 * Walk `Project/Sources/Methods/Compiler_*.4dm` files and collect every
 * `C_TYPE(method; $N)` and `C_TYPE(method; ${N})` declaration into a
 * per-method types record. Returns a map keyed by method name (case-
 * sensitive — first-seen casing wins).
 */
export function discoverCompilerMethodTypes(
  projectRoot: string,
): Map<string, CompilerMethodTypes> {
  const out = new Map<string, CompilerMethodTypes>();
  const methodsDir = path.join(projectRoot, "Project", "Sources", "Methods");
  if (!fs.existsSync(methodsDir)) return out;

  for (const entry of fs.readdirSync(methodsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith("Compiler_") || !entry.name.endsWith(".4dm")) continue;
    scanFile(path.join(methodsDir, entry.name), out);
  }

  return out;
}

function scanFile(
  filePath: string,
  out: Map<string, CompilerMethodTypes>,
): void {
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  for (const raw of source.split(/\r?\n/)) {
    // Strip trailing `//` comment.
    const cleaned = raw.replace(/\/\/.*$/, "");
    const m = cleaned.match(RE_METHOD_PARAM_DECL);
    if (!m) continue;
    const typeWord = m[1].toUpperCase();
    const methodName = m[2];
    const isVariadic = m[3] === "{";
    const positionNum = Number(m[4]);
    const type = TYPE_NAMES_C[typeWord] ?? typeWord;

    let info = out.get(methodName);
    if (!info) {
      info = { name: methodName, paramTypes: new Map() };
      out.set(methodName, info);
    }

    if (positionNum === 0) {
      // `$0` is the return type.
      if (!isVariadic) info.returnType = type;
      // `${0}` is nonsensical; ignore.
      continue;
    }

    if (isVariadic) {
      // Multiple `${N}` declarations for the same method are vanishingly
      // rare, but if they appear, prefer the smallest position (the
      // variadic tail starts there).
      if (info.variadicFrom === undefined || positionNum < info.variadicFrom) {
        info.variadicFrom = positionNum;
        info.variadicType = type;
      }
    } else {
      // Fixed position. First declaration wins.
      if (!info.paramTypes.has(positionNum)) {
        info.paramTypes.set(positionNum, type);
      }
    }
  }
}

/**
 * Materialize a `params[]` array from a `CompilerMethodTypes` entry plus
 * any pre-existing params from the method's `#DECLARE`. Used by the
 * indexer to augment ProjectMethod symbols.
 *
 * Rules:
 *  - Fixed entries from Compiler_* (by position) override #DECLARE types
 *    only when #DECLARE didn't declare a type for that position. Names
 *    come from #DECLARE when available — Compiler_* declarations don't
 *    carry parameter names, only types.
 *  - Variadic tail (from `${N}`) appends as a single `{ name: "...rest",
 *    type, variadic: true }` entry at position N.
 */
export function mergeCompilerParamsWithDeclare(
  declareParams: { name: string; type?: string }[] | undefined,
  compilerInfo: CompilerMethodTypes | undefined,
): { name: string; type?: string; variadic?: boolean }[] | undefined {
  if (!compilerInfo && !declareParams) return undefined;
  if (!compilerInfo) return declareParams;

  // Fixed slots: union of declare positions and compiler positions, indexed
  // from 1. Names come from declare when available; types prefer declare,
  // falling back to compiler.
  const fixedMax = Math.max(
    declareParams?.length ?? 0,
    ...Array.from(compilerInfo.paramTypes.keys(), (n) =>
      compilerInfo.variadicFrom !== undefined ? Math.min(n, compilerInfo.variadicFrom - 1) : n,
    ),
    0,
  );
  const variadicStart = compilerInfo.variadicFrom ?? fixedMax + 1;
  const lastFixed = Math.min(fixedMax, variadicStart - 1);

  const out: { name: string; type?: string; variadic?: boolean }[] = [];
  for (let i = 1; i <= lastFixed; i++) {
    const declParam = declareParams?.[i - 1];
    const compilerType = compilerInfo.paramTypes.get(i);
    out.push({
      name: declParam?.name ?? String(i),
      type: declParam?.type ?? compilerType,
    });
  }
  if (compilerInfo.variadicFrom !== undefined) {
    out.push({
      name: "...rest",
      type: compilerInfo.variadicType,
      variadic: true,
    });
  }
  return out.length > 0 ? out : undefined;
}
