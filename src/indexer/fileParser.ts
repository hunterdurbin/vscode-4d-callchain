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
}

const CLASS_HEADER = /^\s*Class\s+extends\s+([\w.]+)/i;
const FUNCTION_DECL = /^\s*(local\s+|shared\s+)?Function(\s+(get|set))?\s+([\w_]+)\s*\(/i;
const CONSTRUCTOR_DECL = /^\s*Class\s+constructor\b/i;
const PROPERTY_DECL = /^\s*property\s+([\w_]+)/i;
const VAR_DECL = /\bvar\s+\$([\w_]+)\s*:\s*([\w.]+)/g;
const ASSIGN_NEW = /\$([\w_]+)\s*:=\s*cs\.([\w_]+)\.new\s*\(/g;
const ASSIGN_DS_QUERY = /\$([\w_]+)\s*:=\s*ds\.([\w_]+)\.(query|all|fromCollection|new|orderBy)/g;
// Bracket-access: $x:=ds[_Table].new() → cs.Table[Entity]; .get/.first → entity; .query/.all → selection.
const ASSIGN_DS_BRACKET_NEW = /\$([\w_]+)\s*:=\s*ds\s*\[\s*([\w_]+)\s*\]\s*\.\s*(new|get|first|last)\s*\(/g;
const ASSIGN_DS_BRACKET_QUERY = /\$([\w_]+)\s*:=\s*ds\s*\[\s*([\w_]+)\s*\]\s*\.\s*(query|all|fromCollection|orderBy)/g;
const DECLARE_PARAMS = /#DECLARE\s*\(([^)]*)\)(?:\s*->\s*\$[\w_]+\s*:\s*([\w.]+))?/;
// `$var := "literal"` — track for intra-method form-name resolution.
const ASSIGN_STRING_LITERAL = /\$([\w_]+)\s*:=\s*"\x01(\d+)\x01"/g;

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
    symbols.push({
      id: symbolIdFor(kind, name),
      name,
      kind,
      location: { uri: fileUri, line: 0 }
    });
  } else if (file.category === "formObjectMethod" || file.category === "tableObjectMethod") {
    const objName = path.basename(file.absolutePath, ".4dm");
    const name = `${file.containerName ?? "Form"}.${objName}`;
    const kind = file.category === "formObjectMethod" ? SymbolKind.FormObjectMethod : SymbolKind.TableObjectMethod;
    symbols.push({
      id: symbolIdFor(kind, name),
      name,
      kind,
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
    const formSym: SymbolRecord = {
      id: symbolIdFor(kind, formName),
      name: formName,
      kind,
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
        symbols.push(sym);
        currentSymbolId = sym.id;
        currentLocals = new Map();
        currentStrings = new Map();
        localTypes.set(currentSymbolId, currentLocals);
        localStrings.set(currentSymbolId, currentStrings);
        // Continue — the function-decl line itself may also contain #DECLARE params via a different line
        continue;
      }
      const propMatch = rawLine.match(PROPERTY_DECL);
      if (propMatch) {
        // Properties are not callable but we record nothing extra here.
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
      currentLocals.set(vmatch[1], `cs.${vmatch[2]}`);
    }
    ASSIGN_DS_QUERY.lastIndex = 0;
    while ((vmatch = ASSIGN_DS_QUERY.exec(line))) {
      currentLocals.set(vmatch[1], `entitySelectionOf:${vmatch[2]}`);
    }
    ASSIGN_DS_BRACKET_NEW.lastIndex = 0;
    while ((vmatch = ASSIGN_DS_BRACKET_NEW.exec(line))) {
      // Strip leading underscore from the constant identifier. Final mapping to
      // the actual class happens in the resolver (catalog-validated).
      const tableName = vmatch[2].replace(/^_/, "");
      currentLocals.set(vmatch[1], `dsTable:${tableName}`);
    }
    ASSIGN_DS_BRACKET_QUERY.lastIndex = 0;
    while ((vmatch = ASSIGN_DS_BRACKET_QUERY.exec(line))) {
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

    const sites = extractCallSitesFromLine(line, strings, currentSymbolId, i, constantsSet);
    for (const s of sites) rawCalls.push(s);
  }

  return { file, symbols, rawCalls, localTypes, localStrings, classInfo };
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
