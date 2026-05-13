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
const DECLARE_PARAMS = /#DECLARE\s*\(([^)]*)\)(?:\s*->\s*\$[\w_]+\s*:\s*([\w.]+))?/;

export function parseFile(file: DiscoveredFile, projectRootUri: string): ParsedFile {
  let source: string;
  try {
    source = fs.readFileSync(file.absolutePath, "utf8");
  } catch {
    return {
      file,
      symbols: [],
      rawCalls: [],
      localTypes: new Map()
    };
  }
  const cleaned = stripBlockComments(source);
  const lines = cleaned.split(/\r?\n/);

  const fileUri = pathToUri(file.absolutePath);
  const symbols: SymbolRecord[] = [];
  const rawCalls: RawCallSite[] = [];
  const localTypes = new Map<string, Map<string, string>>();
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
  }

  // ---------- Inner functions (class only) + collect call sites ----------
  // We track "the symbol whose body we are currently in" so call sites
  // are attributed correctly.
  let currentSymbolId = symbols[0]?.id;
  let currentLocals = new Map<string, string>();
  if (currentSymbolId) localTypes.set(currentSymbolId, currentLocals);

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
        localTypes.set(currentSymbolId, currentLocals);
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

    const sites = extractCallSitesFromLine(line, strings, currentSymbolId, i);
    for (const s of sites) rawCalls.push(s);
  }

  return { file, symbols, rawCalls, localTypes, classInfo };
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
