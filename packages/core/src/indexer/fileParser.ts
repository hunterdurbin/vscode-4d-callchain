import * as fs from "fs";
import * as path from "path";
import { ClassFlavor, FileLocation, RawCallSite, SymbolKind, SymbolRecord, symbolIdFor } from "../model/symbol";
import { DiscoveredFile } from "./projectScanner";
import { extractCallSitesFromLine } from "./callExtractor";
import { stripBlockComments, cleanLine } from "../util/textCleanup";

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
}

const CLASS_HEADER = /^\s*Class\s+extends\s+([\w.]+)/i;
const FUNCTION_DECL = /^\s*(local\s+|shared\s+)?Function(\s+(get|set))?\s+([\w_]+)\s*\(/i;
const CONSTRUCTOR_DECL = /^\s*Class\s+constructor\b/i;
const PROPERTY_DECL = /^\s*property\s+([\w_]+)/i;
const PROPERTY_DECL_TYPED = /^\s*property\s+([\w_]+)\s*:\s*([\w.]+)/i;
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

export function parseFile(file: DiscoveredFile, projectRootUri: string, constantsSet?: Set<string>): ParsedFile {
  let source: string;
  try {
    source = fs.readFileSync(file.absolutePath, "utf8");
  } catch {
    return {
      file,
      symbols: [],
      rawCalls: [],
      localTypes: new Map(),
      localStrings: new Map()
    };
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
    return { file, symbols, rawCalls, localTypes, localStrings };
  }

  // ---------- Inner functions (class only) + collect call sites ----------
  // We track "the symbol whose body we are currently in" so call sites
  // are attributed correctly.
  let currentSymbolId = symbols[0]?.id;
  let currentLocals = new Map<string, string>();
  let currentStrings = new Map<string, string>();
  if (currentSymbolId) {
    localTypes.set(currentSymbolId, currentLocals);
    localStrings.set(currentSymbolId, currentStrings);
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const { text: line, strings } = cleanLine(rawLine);

    if (file.category === "class") {
      const ctor = CONSTRUCTOR_DECL.test(rawLine);
      const funcMatch = rawLine.match(FUNCTION_DECL);
      if (ctor || funcMatch) {
        const className = classInfo!.name;
        const isCtor = ctor;
        const name = isCtor ? "constructor" : funcMatch![4];
        const accessor = funcMatch?.[3] as "get" | "set" | undefined;
        const scope = funcMatch?.[1]?.trim() as "local" | "shared" | undefined;
        const kind = isCtor
          ? SymbolKind.ClassConstructor
          : accessor === "get" ? SymbolKind.ClassGetter
          : accessor === "set" ? SymbolKind.ClassSetter
          : SymbolKind.ClassFunction;
        const sym: SymbolRecord = {
          id: symbolIdFor(kind, name, className),
          name,
          kind,
          ownerClass: className,
          accessor: accessor ?? "function",
          scope: scope ?? "public",
          location: { uri: fileUri, line: i }
        };
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
          const paramRe = /\$([\w_]+)\s*:\s*([\w.]+)/g;
          let pm: RegExpExecArray | null;
          while ((pm = paramRe.exec(paramText))) {
            currentLocals.set(pm[1], pm[2]);
          }
        }
        // Continue — the function-decl line itself may also contain #DECLARE params via a different line
        continue;
      }
      const propMatch = rawLine.match(PROPERTY_DECL);
      if (propMatch) {
        // Record the property's declared type for chain resolution.
        // `property foo : cs.Bar` -> {foo -> cs.Bar}.
        const typedMatch = rawLine.match(PROPERTY_DECL_TYPED);
        if (typedMatch) classPropertyTypes.set(typedMatch[1], typedMatch[2]);
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

    // #DECLARE parameter types
    const dec = line.match(DECLARE_PARAMS);
    if (dec) {
      const paramText = dec[1];
      const paramRe = /\$([\w_]+)\s*:\s*([\w.]+)/g;
      let pm: RegExpExecArray | null;
      while ((pm = paramRe.exec(paramText))) {
        currentLocals.set(pm[1], pm[2]);
      }
    }

    if (!currentSymbolId) continue;

    const sites = extractCallSitesFromLine(line, strings, currentSymbolId, i, constantsSet, currentStrings);
    for (const s of sites) rawCalls.push(s);
  }

  return {
    file,
    symbols,
    rawCalls,
    localTypes,
    localStrings,
    classInfo,
    classPropertyTypes: classPropertyTypes.size > 0 ? classPropertyTypes : undefined,
    classMethodReturnsByName: classMethodReturnsByName.size > 0 ? classMethodReturnsByName : undefined
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
