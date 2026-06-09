import * as fs from "fs";
import * as path from "path";
import { ClassFlavor, FileLocation, LocalUsageSite, RawCallSite, SymbolKind, SymbolParam, SymbolRecord, symbolIdFor } from "../model/symbol";
import { DiscoveredFile } from "./projectScanner";
import { extractCallSitesFromLine } from "./callExtractor";
import { stripBlockComments, cleanLine } from "../util/textCleanup";

/**
 * Parse a `Function foo($a : T; $b; $c : U)` parameter list. Tolerates params
 * without a declared type (Position-only `$a`). Returns an ordered list.
 */
function parseParamList(paramText: string): SymbolParam[] {
  const out: SymbolParam[] = [];
  for (const raw of paramText.split(";")) {
    const m = raw.match(/\$([\w_]+)\s*(?::\s*([\w.]+))?/);
    if (!m) continue;
    out.push(m[2] ? { name: m[1], type: m[2] } : { name: m[1] });
  }
  return out;
}

export interface ParsedFile {
  file: DiscoveredFile;
  symbols: SymbolRecord[];
  rawCalls: RawCallSite[];
  /** Per-symbol local variable type table (built during call extraction). */
  localTypes: Map<string, Map<string, string>>;
  /**
   * Per-symbol map of `$var → string literal` assignments. Populated when the
   * parser sees patterns like `$formName:="Commissions_Admin"`. The resolver
   * uses this to recover the form name from `DIALOG([T]; $formName)` etc.
   * Intra-method only — cross-method passing is out of scope.
   */
  localStrings: Map<string, Map<string, string>>;
  classInfo?: {
    name: string;
    extends?: string;
    flavor: ClassFlavor;
  };
  /**
   * Property/getter types for the file's class, used by the chain resolver
   * to walk `$x.prop.method()` patterns. Keyed by property/getter name;
   * value is the declared type string (e.g. `cs.Foo`, `cs.NS.Bar`, `Text`).
   * Only populated for class files.
   */
  classPropertyTypes?: Map<string, string>;
  /**
   * Method return types for the file's class — `Function name(...) : Type`.
   * Used by the chain resolver to walk `$x.method().prop.foo()` patterns.
   * Getters are stored in `classPropertyTypes` instead; this map only
   * carries plain functions.
   */
  classMethodReturnsByName?: Map<string, string>;
  /**
   * Per-symbol map of `$var → read sites`. Populated by the tree-sitter
   * parser only — the regex fallback leaves it empty. Consumed by the
   * linter's unused-local / unused-parameter rules. Reads are every
   * non-LHS appearance of a `local_var` node (RHS of assignments, call
   * args, conditions, return values, for-loop bounds, etc.).
   */
  localReads: Map<string, Map<string, LocalUsageSite[]>>;
  /**
   * Per-symbol map of `$var → write sites`. Tracks every assignment
   * (`$x := …`) target. Distinct from `localTypes`, which only records
   * the *type* of writes whose RHS the inferer could classify. Used by
   * unused-local (a name with writes but no reads is dead) and by
   * `decl/implicit-local` (combined with `localDeclMode`). Tree-sitter
   * parser only; regex fallback leaves it empty.
   */
  localWrites: Map<string, Map<string, LocalUsageSite[]>>;
  /**
   * Per-symbol map of `$var → "declared" | "implicit"`. "declared" means
   * the variable was introduced via `var`, legacy `C_*`, `#DECLARE`, or
   * a parameter list — anywhere in the function body, in any order.
   * "implicit" means the only mention is an assignment target with no
   * preceding declaration in scope. Used by the `decl/implicit-local`
   * rule. Tree-sitter parser only; regex fallback leaves it empty.
   */
  localDeclMode: Map<string, Map<string, "declared" | "implicit">>;
}

const CLASS_HEADER = /^\s*Class\s+extends\s+([\w.]+)/i;
const FUNCTION_DECL = /^\s*(local\s+|shared\s+)?Function(\s+(get|set|query|orderBy))?\s+([\w_]+)\s*\(/i;
// ORDA computed/alias attribute: `Alias <name> <targetPath>` (e.g.
// `Alias invoiceId invoice.InvoiceID`). Declared at class level.
const ALIAS_DECL = /^\s*Alias\s+([\w_]+)\s+([\w_.[\]]+)/i;
const CONSTRUCTOR_DECL = /^\s*Class\s+constructor\b/i;
// `property name`, `property name : Type`, or multiple `;`-separated names
// sharing a trailing type: `property text1; text2 : Text`. Group 1 is the
// `;`-separated name list, group 2 the optional shared type.
const PROPERTY_DECL = /^\s*property\s+([\w_]+(?:\s*;\s*[\w_]+)*)\s*(?::\s*([\w.]+))?/i;
// Function decl with a return-type annotation: `Function foo(...) : Type`.
// Captures the closing `)` + `:` so we can pull the type. Tolerates multi-line
// signatures by extracting from the same physical line (multi-line decls are
// uncommon for getters specifically).
const FUNCTION_RETURN_TYPE = /\)\s*:\s*([\w.]+)/;
const VAR_DECL = /\bvar\s+\$([\w_]+)\s*:\s*([\w.]+)/g;
const ASSIGN_NEW = /\$([\w_]+)\s*:=\s*cs\.([\w_]+)\.new\s*\(/g;
// `ds.Foo.new(...)` returns a single entity, NOT a selection — separated so
// the chain resolver can route .save() / .drop() / etc. correctly.
const ASSIGN_DS_NEW = /\$([\w_]+)\s*:=\s*ds\.([\w_]+)\.(new|get)\s*\(/g;
const ASSIGN_DS_QUERY = /\$([\w_]+)\s*:=\s*ds\.([\w_]+)\.(query|all|fromCollection|orderBy|newSelection)/g;
// Bracket-access: $x:=ds[_Table].new() → cs.Table[Entity]; .get/.first → entity; .query/.all → selection.
const ASSIGN_DS_BRACKET_NEW = /\$([\w_]+)\s*:=\s*ds\s*\[\s*([\w_]+)\s*\]\s*\.\s*(new|get|first|last)\s*\(/g;
const ASSIGN_DS_BRACKET_QUERY = /\$([\w_]+)\s*:=\s*ds\s*\[\s*([\w_]+)\s*\]\s*\.\s*(query|all|fromCollection|orderBy)/g;
const DECLARE_PARAMS = /#DECLARE\s*\(([^)]*)\)(?:\s*->\s*\$[\w_]+\s*:\s*([\w.]+))?/;
// `$var := "literal"` — track for intra-method form-name resolution.
const ASSIGN_STRING_LITERAL = /\$([\w_]+)\s*:=\s*"\x01(\d+)\x01"/g;
// Legacy `C_<TYPE>($a; $b; ...)` declarations — see the body loop for
// continuation handling. Each var receives a canonical type so chain
// resolution treats e.g. `$col.push()` as a Collection builtin.

function parenBalance(s: string): number {
  let n = 0;
  for (const c of s) {
    if (c === "(") n++;
    else if (c === ")") n--;
  }
  return n;
}

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

/**
 * Given a position pointing at an opening `(`, return true when a `.<method>(`
 * style chain follows the matching `)`. Used by the assignment trackers so
 * we don't mis-type a variable when the RHS is something like
 * `cs.Foo.new(...).fromConfig(...)` — the actual return type is whatever
 * `fromConfig` produces, not Foo itself.
 */
function isAssignmentChained(line: string, openParenIdx: number): boolean {
  if (line[openParenIdx] !== "(") return false;
  let depth = 1;
  let p = openParenIdx + 1;
  while (p < line.length && depth > 0) {
    const c = line[p];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    p++;
  }
  if (depth !== 0) return false;
  while (p < line.length && line[p] === " ") p++;
  return line[p] === ".";
}

export function parseFile(file: DiscoveredFile, projectRootUri: string, constantsSet?: Set<string>, presetSource?: string): ParsedFile {
  // Tree-sitter is the default once `initTreeSitterParser()` has resolved
  // (the LSP servers and extension host await it at startup). The legacy
  // regex parser is the fallback when the WASM init hasn't completed
  // (e.g. during early startup, in tests, or on a failed init). Opt-out
  // via `FOURD_PARSER=regex` for emergencies.
  //
  // `presetSource` lets hot-path callers (rebuild / patch loops) read the
  // file asynchronously and hand the contents in, keeping the disk wait off
  // the extension-host thread. When omitted, the parser reads synchronously.
  if (process.env.FOURD_PARSER !== "regex") {
    try {
      const ts: typeof import("../parser/parseWithTreeSitter") = require("../parser/parseWithTreeSitter");
      if (ts.isTreeSitterReady()) {
        return ts.parseFileWithTreeSitter(file, constantsSet, presetSource);
      }
    } catch {
      // Fall through to the regex parser silently.
    }
  }
  let source: string;
  if (presetSource !== undefined) {
    source = presetSource;
  } else {
    try {
      source = fs.readFileSync(file.absolutePath, "utf8");
    } catch {
      return {
        file,
        symbols: [],
        rawCalls: [],
        localTypes: new Map(),
        localStrings: new Map(),
        localReads: new Map(),
        localWrites: new Map(),
        localDeclMode: new Map()
      };
    }
  }
  const cleaned = stripBlockComments(source);
  const lines = cleaned.split(/\r?\n/);

  const fileUri = pathToUri(file.absolutePath);
  const symbols: SymbolRecord[] = [];
  const rawCalls: RawCallSite[] = [];
  const localTypes = new Map<string, Map<string, string>>();
  const localStrings = new Map<string, Map<string, string>>();
  const classPropertyTypes = new Map<string, string>();
  const classMethodReturnsByName = new Map<string, string>();
  let classInfo: ParsedFile["classInfo"];

  // ---------- Symbol creation ----------
  if (file.category === "method") {
    const base = path.basename(file.absolutePath, ".4dm");
    const sym: SymbolRecord = {
      id: symbolIdFor(SymbolKind.ProjectMethod, base),
      name: base,
      kind: SymbolKind.ProjectMethod,
      location: { uri: fileUri, line: 0 }
    };
    symbols.push(sym);
  } else if (file.category === "compilerMethod") {
    const base = path.basename(file.absolutePath, ".4dm");
    symbols.push({
      id: symbolIdFor(SymbolKind.CompilerMethod, base),
      name: base,
      kind: SymbolKind.CompilerMethod,
      location: { uri: fileUri, line: 0 }
    });
  } else if (file.category === "class") {
    const className = file.containerName ?? path.basename(file.absolutePath, ".4dm");
    let flavor: ClassFlavor = ClassFlavor.Generic;
    let extendsClass: string | undefined;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(CLASS_HEADER);
      if (m) {
        extendsClass = m[1];
        flavor = classifyFlavor(className, extendsClass);
        break;
      }
    }
    if (className.endsWith("_Test")) {
      flavor = ClassFlavor.Test;
    }
    classInfo = { name: className, extends: extendsClass, flavor };
    const classSym: SymbolRecord = {
      id: symbolIdFor(SymbolKind.Class, className),
      name: className,
      kind: SymbolKind.Class,
      location: { uri: fileUri, line: 0 },
      classFlavor: flavor,
      extendsClass
    };
    symbols.push(classSym);
  } else if (file.category === "formMethod" || file.category === "tableFormMethod") {
    const name = `${file.containerName ?? "Form"}.method`;
    const kind = file.category === "formMethod" ? SymbolKind.FormMethod : SymbolKind.TableFormMethod;
    const ownerTable = file.category === "tableFormMethod" ? file.ownerTableId : undefined;
    symbols.push({
      id: ownerTable ? `${kind}:${ownerTable}.${name}` : symbolIdFor(kind, name),
      name,
      kind,
      ownerTable,
      location: { uri: fileUri, line: 0 }
    });
  } else if (file.category === "formObjectMethod" || file.category === "tableObjectMethod") {
    const objName = path.basename(file.absolutePath, ".4dm");
    const name = `${file.containerName ?? "Form"}.${objName}`;
    const kind = file.category === "formObjectMethod" ? SymbolKind.FormObjectMethod : SymbolKind.TableObjectMethod;
    const ownerTable = file.category === "tableObjectMethod" ? file.ownerTableId : undefined;
    symbols.push({
      id: ownerTable ? `${kind}:${ownerTable}.${name}` : symbolIdFor(kind, name),
      name,
      kind,
      ownerTable,
      location: { uri: fileUri, line: 0 }
    });
  } else if (file.category === "databaseMethod") {
    const base = path.basename(file.absolutePath, ".4dm");
    symbols.push({
      id: symbolIdFor(SymbolKind.DatabaseMethod, base),
      name: base,
      kind: SymbolKind.DatabaseMethod,
      location: { uri: fileUri, line: 0 }
    });
  } else if (file.category === "formDefinition" || file.category === "tableFormDefinition") {
    // The form file is JSON — give it its own first-class symbol so the
    // file lights up with CodeLens / cursor-tracker / Symbols-view entries
    // independently of its `method.4dm` companion. dataSource/expression
    // refs are attributed to this Form symbol (NOT FormMethod).
    const kind = file.category === "formDefinition" ? SymbolKind.Form : SymbolKind.TableForm;
    const formName = file.containerName ?? "Form";
    const ownerTable = file.category === "tableFormDefinition" ? file.ownerTableId : undefined;
    const formSym: SymbolRecord = {
      id: ownerTable ? `${kind}:${ownerTable}.${formName}` : symbolIdFor(kind, formName),
      name: formName,
      kind,
      ownerTable,
      location: { uri: fileUri, line: 0 }
    };
    symbols.push(formSym);
    extractFormDataSourceCalls(source, formSym.id, constantsSet, rawCalls);
    return {
      file,
      symbols,
      rawCalls,
      localTypes,
      localStrings,
      localReads: new Map(),
      localWrites: new Map(),
      localDeclMode: new Map()
    };
  }

  // ---------- Inner functions (class only) + collect call sites ----------
  // We track "the symbol whose body we are currently in" so call sites
  // are attributed correctly. `currentSym` is the same record by reference so
  // late discoveries (e.g. `#DECLARE` inside the body) can mutate it.
  let currentSym: SymbolRecord | undefined = symbols[0];
  let currentSymbolId = currentSym?.id;
  let currentLocals = new Map<string, string>();
  let currentStrings = new Map<string, string>();
  if (currentSymbolId) {
    localTypes.set(currentSymbolId, currentLocals);
    localStrings.set(currentSymbolId, currentStrings);
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const { text: line, strings, cols } = cleanLine(rawLine);

    if (file.category === "class") {
      const ctor = CONSTRUCTOR_DECL.test(rawLine);
      const funcMatch = rawLine.match(FUNCTION_DECL);
      if (ctor || funcMatch) {
        const className = classInfo!.name;
        const isCtor = ctor;
        const name = isCtor ? "constructor" : funcMatch![4];
        const accessor = funcMatch?.[3]?.toLowerCase() as "get" | "set" | "query" | "orderby" | undefined;
        const scope = funcMatch?.[1]?.trim() as "local" | "shared" | undefined;
        // get/set are computed-attribute accessors; query/orderBy are the
        // optimized-query and sort backers for a computed attribute (still
        // ClassFunctions, but tagged via accessor + computedFor so they can be
        // told apart from the same-named getter).
        const kind = isCtor
          ? SymbolKind.ClassConstructor
          : accessor === "get" ? SymbolKind.ClassGetter
          : accessor === "set" ? SymbolKind.ClassSetter
          : SymbolKind.ClassFunction;
        const accessorTag: SymbolRecord["accessor"] =
          accessor === "orderby" ? "orderBy" : (accessor ?? "function");
        // Find the identifier's column on the decl line so go-to-def lands at
        // the start of the name, and hover ranges highlight just the name.
        // `Class constructor` has no captured name — point at `constructor`.
        const identifierStr = isCtor ? "constructor" : funcMatch![4];
        const column = rawLine.indexOf(identifierStr, isCtor ? rawLine.indexOf("Class") : 0);
        const sym: SymbolRecord = {
          id: symbolIdFor(kind, name, className),
          name,
          kind,
          ownerClass: className,
          accessor: accessorTag,
          scope: scope ?? "public",
          location: column >= 0
            ? { uri: fileUri, line: i, column, endColumn: column + identifierStr.length }
            : { uri: fileUri, line: i }
        };
        // query/orderBy back the computed attribute of the same name — record
        // the link so get_symbol can disambiguate by role.
        if (accessorTag === "query" || accessorTag === "orderBy") sym.computedFor = name;
        // Capture the return type for chain resolution:
        // - Typed getters land in classPropertyTypes (property-like lookup)
        // - Plain functions land in classMethodReturnsByName (call-step lookup)
        if (!isCtor) {
          const retMatch = rawLine.match(FUNCTION_RETURN_TYPE);
          if (retMatch) {
            if (accessor === "get") classPropertyTypes.set(name, retMatch[1]);
            else if (!accessor) classMethodReturnsByName.set(name, retMatch[1]);
          }
        }
        symbols.push(sym);
        currentSym = sym;
        currentSymbolId = sym.id;
        currentLocals = new Map();
        currentStrings = new Map();
        localTypes.set(currentSymbolId, currentLocals);
        localStrings.set(currentSymbolId, currentStrings);
        // Extract parameter types from the function-declaration line itself:
        // `Function foo($t : cs.NS.Class; $b : Integer)` — record each param so
        // subsequent `$t.method()` calls can be resolved against the type.
        const openParen = rawLine.indexOf("(");
        if (openParen !== -1) {
          const closeParen = rawLine.indexOf(")", openParen);
          const paramText = closeParen !== -1 ? rawLine.slice(openParen + 1, closeParen) : rawLine.slice(openParen + 1);
          const params = parseParamList(paramText);
          if (params.length > 0) {
            sym.params = params;
            for (const p of params) {
              if (p.type) currentLocals.set(p.name, p.type);
            }
          }
        }
        // Continue — the function-decl line itself may also contain #DECLARE params via a different line
        continue;
      }
      const propMatch = rawLine.match(PROPERTY_DECL);
      if (propMatch && classInfo) {
        // Each name becomes a first-class ClassProperty symbol (so it accrues
        // read/write usage edges) and records its declared type for chain
        // resolution. The shared type applies to every name on the line:
        // `property a; b : cs.Bar` -> {a -> cs.Bar, b -> cs.Bar}.
        const type = propMatch[2];
        let searchFrom = rawLine.toLowerCase().indexOf("property") + "property".length;
        for (const rawName of propMatch[1].split(";")) {
          const name = rawName.trim();
          if (!name) continue;
          const col = rawLine.indexOf(name, searchFrom);
          if (col >= 0) searchFrom = col + name.length;
          symbols.push({
            id: symbolIdFor(SymbolKind.ClassProperty, name, classInfo.name),
            name,
            kind: SymbolKind.ClassProperty,
            ownerClass: classInfo.name,
            location: col >= 0
              ? { uri: fileUri, line: i, column: col, endColumn: col + name.length }
              : { uri: fileUri, line: i }
          });
          if (type) classPropertyTypes.set(name, type);
        }
        continue;
      }
      const aliasMatch = rawLine.match(ALIAS_DECL);
      if (aliasMatch) {
        // `Alias <name> <targetPath>` — a queryable computed attribute. Index
        // it as its own symbol carrying the target path so it's discoverable
        // and its target relation is navigable. Doesn't open a body, so it
        // leaves currentSymbolId untouched.
        const aliasName = aliasMatch[1];
        const target = aliasMatch[2];
        const col = rawLine.indexOf(aliasName, rawLine.indexOf("Alias") + 5);
        symbols.push({
          id: symbolIdFor(SymbolKind.Alias, aliasName, classInfo!.name),
          name: aliasName,
          kind: SymbolKind.Alias,
          ownerClass: classInfo!.name,
          aliasTarget: target,
          location: col >= 0
            ? { uri: fileUri, line: i, column: col, endColumn: col + aliasName.length }
            : { uri: fileUri, line: i }
        });
        continue;
      }
    }

    // Capture local type info from var $x : cs.Foo
    let vmatch: RegExpExecArray | null;
    VAR_DECL.lastIndex = 0;
    while ((vmatch = VAR_DECL.exec(line))) {
      currentLocals.set(vmatch[1], vmatch[2]);
    }
    ASSIGN_NEW.lastIndex = 0;
    while ((vmatch = ASSIGN_NEW.exec(line))) {
      // Skip if the .new(...) is followed by a chained call; we can't infer
      // the final return type without resolver context.
      if (isAssignmentChained(line, vmatch.index + vmatch[0].length - 1)) continue;
      currentLocals.set(vmatch[1], `cs.${vmatch[2]}`);
    }
    ASSIGN_DS_NEW.lastIndex = 0;
    while ((vmatch = ASSIGN_DS_NEW.exec(line))) {
      if (isAssignmentChained(line, vmatch.index + vmatch[0].length - 1)) continue;
      // ds.Foo.new() / .get() → single entity, share the bracket convention.
      currentLocals.set(vmatch[1], `dsTable:${vmatch[2]}`);
    }
    ASSIGN_DS_QUERY.lastIndex = 0;
    while ((vmatch = ASSIGN_DS_QUERY.exec(line))) {
      // ASSIGN_DS_QUERY doesn't capture the `(`, so we have to find the next
      // `(` after the match and start walking from there.
      const openParen = line.indexOf("(", vmatch.index + vmatch[0].length - 1);
      if (openParen !== -1 && isAssignmentChained(line, openParen)) continue;
      currentLocals.set(vmatch[1], `entitySelectionOf:${vmatch[2]}`);
    }
    ASSIGN_DS_BRACKET_NEW.lastIndex = 0;
    while ((vmatch = ASSIGN_DS_BRACKET_NEW.exec(line))) {
      if (isAssignmentChained(line, vmatch.index + vmatch[0].length - 1)) continue;
      // Strip leading underscore from the constant identifier. Final mapping to
      // the actual class happens in the resolver (catalog-validated).
      const tableName = vmatch[2].replace(/^_/, "");
      currentLocals.set(vmatch[1], `dsTable:${tableName}`);
    }
    ASSIGN_DS_BRACKET_QUERY.lastIndex = 0;
    while ((vmatch = ASSIGN_DS_BRACKET_QUERY.exec(line))) {
      const openParen = line.indexOf("(", vmatch.index + vmatch[0].length - 1);
      if (openParen !== -1 && isAssignmentChained(line, openParen)) continue;
      const tableName = vmatch[2].replace(/^_/, "");
      currentLocals.set(vmatch[1], `dsTableSelection:${tableName}`);
    }
    // String-literal assignments — `$formName:="Commissions_Admin"`. The
    // resolver consults this when a form-opening call passes `$formName` in
    // the form-name slot.
    ASSIGN_STRING_LITERAL.lastIndex = 0;
    while ((vmatch = ASSIGN_STRING_LITERAL.exec(line))) {
      const idx = Number(vmatch[2]);
      const value = strings[idx];
      if (value !== undefined) currentStrings.set(vmatch[1], value);
    }

    // Legacy `C_<TYPE>($a; $b; ...)` declarations — common in pre-v18 4D code.
    // The argument list often continues across multiple lines via `\`, so we
    // detect the opening pattern and forward-scan to balance the parens before
    // applying the regex.
    const ctypeOpen = line.match(/\bC_(LONGINT|INTEGER|REAL|NUMERIC|TEXT|STRING|ALPHA|BOOLEAN|DATE|TIME|BLOB|PICTURE|OBJECT|COLLECTION|POINTER|VARIANT)\s*\(/i);
    if (ctypeOpen) {
      const canon = canonicalCType(ctypeOpen[1]);
      // Accumulate text until parens balance (or EOF).
      let buf = line;
      let j = i + 1;
      while (parenBalance(buf) > 0 && j < lines.length) {
        buf += " " + cleanLine(lines[j]).text;
        j++;
      }
      // Now extract vars across the buffered C_TYPE block.
      if (canon) {
        const blockMatch = buf.match(/\bC_\w+\s*\(([^)]*)\)/i);
        if (blockMatch) {
          for (const part of blockMatch[1].split(/[;,]/)) {
            const vm = part.match(/\$([\w_]+)/);
            if (vm) currentLocals.set(vm[1], canon);
          }
        }
      }
    }

    // #DECLARE parameter types
    const dec = line.match(DECLARE_PARAMS);
    if (dec) {
      const paramText = dec[1];
      const params = parseParamList(paramText);
      for (const p of params) {
        if (p.type) currentLocals.set(p.name, p.type);
      }
      // Persist on the current symbol if it doesn't already have params
      // (e.g. ProjectMethod file-level symbols, or class functions declared
      // with an empty `(...)` and a follow-up #DECLARE).
      if (currentSym && (!currentSym.params || currentSym.params.length === 0) && params.length > 0) {
        currentSym.params = params;
      }
    }

    if (!currentSymbolId) continue;

    const sites = extractCallSitesFromLine(line, strings, currentSymbolId, i, constantsSet, currentStrings);
    // Translate cleaned-line columns → raw-line columns via the `cols` map.
    // Columns from extractCallSitesFromLine reference positions in the cleaned
    // line; downstream LSP features need source-file positions.
    for (const s of sites) {
      if (s.column !== undefined) {
        const c = cols[s.column];
        s.column = c !== undefined ? c : s.column;
      }
      if (s.endColumn !== undefined) {
        const e = cols[s.endColumn];
        s.endColumn = e !== undefined ? e : s.endColumn;
      }
      rawCalls.push(s);
    }
  }

  return {
    file,
    symbols,
    rawCalls,
    localTypes,
    localStrings,
    classInfo,
    classPropertyTypes: classPropertyTypes.size > 0 ? classPropertyTypes : undefined,
    classMethodReturnsByName: classMethodReturnsByName.size > 0 ? classMethodReturnsByName : undefined,
    // Regex fallback doesn't populate these — Phase A is tree-sitter only.
    localReads: new Map(),
    localWrites: new Map(),
    localDeclMode: new Map()
  };
}

/**
 * Form-definition files are JSON. The keys below carry short 4D expressions
 * — typically a single identifier (process variable name) or a member-access
 * chain into the form context. Walk the JSON and run the existing extractor
 * on each value so the referenced symbols become callees of the form.
 */
const FORM_EXPR_KEYS = new Set([
  "dataSource",
  "expression",
  "variableCalculation",
  "columnDataSource",
  "methodName"
]);

function extractFormDataSourceCalls(
  source: string,
  ownerId: string,
  constantsSet: Set<string> | undefined,
  rawCalls: RawCallSite[]
): void {
  let doc: any;
  try { doc = JSON.parse(source); } catch { return; }
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const c of node) visit(c); return; }
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string" && FORM_EXPR_KEYS.has(key)) {
        // Form JSON expressions live at synthetic line 0; columns are not
        // meaningful here, so emit cleaned-line columns as-is (they only feed
        // semantic-token/diagnostic ranges, which downstream code guards on
        // `column !== undefined` and falls back to whole-line ranges).
        const { text, strings } = cleanLine(value);
        const sites = extractCallSitesFromLine(text, strings, ownerId, 0, constantsSet);
        for (const s of sites) rawCalls.push(s);
      } else if (value && typeof value === "object") {
        visit(value);
      }
    }
  };
  visit(doc);
}

function classifyFlavor(className: string, extendsClass: string): ClassFlavor {
  switch (extendsClass) {
    case "Entity": return ClassFlavor.Entity;
    case "EntitySelection": return ClassFlavor.EntitySelection;
    case "DataClass": return ClassFlavor.DataClass;
    case "DataStoreImplementation":
    case "DataStore": return ClassFlavor.DataStore;
    default: break;
  }
  if (extendsClass.endsWith("_I")) return ClassFlavor.Interface;
  if (className.endsWith("Entity")) return ClassFlavor.Entity;
  if (className.endsWith("Selection")) return ClassFlavor.EntitySelection;
  return ClassFlavor.Generic;
}

function pathToUri(p: string): string {
  return "file://" + p.split(path.sep).map(encodeURIComponent).join("/").replace(/%2F/g, "/");
}
