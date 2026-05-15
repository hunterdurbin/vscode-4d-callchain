import { CallEdge, CallKind, INDEX_VERSION, RawCallSite, SymbolIndex, SymbolKind, SymbolRecord, symbolIdFor } from "../model/symbol";
import { ParsedFile } from "./fileParser";
import builtinsData from "../model/builtins.json";

const BUILTIN_SET = new Set<string>((builtinsData as any).commands);
const PLUGIN_PREFIXES: string[] = (builtinsData as any).pluginCommandPrefixes ?? [];

export interface ResolverInput {
  files: ParsedFile[];
  plugins: { name: string; symbolId: string }[];
  /** Catalog table names from `Project/Sources/Catalog/Tables/*.json`. */
  catalogTables: Set<string>;
}

export interface ResolverOutput {
  edges: CallEdge[];
  unresolvedSymbols: SymbolRecord[];
}

export function resolve(input: ResolverInput, projectSymbols: SymbolRecord[]): ResolverOutput {
  const edges: CallEdge[] = [];
  const unresolved: SymbolRecord[] = [];
  const unresolvedSeen = new Set<string>();

  // Build indexes for fast lookup.
  const byName = new Map<string, SymbolRecord[]>();
  const classByName = new Map<string, SymbolRecord>();
  for (const s of projectSymbols) {
    const key = s.name.toLowerCase();
    const arr = byName.get(key) ?? [];
    arr.push(s);
    byName.set(key, arr);
    if (s.kind === SymbolKind.Class) {
      classByName.set(s.name.toLowerCase(), s);
    }
  }
  const classFunctions = new Map<string, SymbolRecord>(); // key: className.fnName (lowercase)
  const classGetters   = new Map<string, SymbolRecord>(); // key: className.propName (lowercase)
  const classSetters   = new Map<string, SymbolRecord>(); // key: className.propName (lowercase)
  for (const s of projectSymbols) {
    if (!s.ownerClass) continue;
    const key = `${s.ownerClass}.${s.name}`.toLowerCase();
    switch (s.kind) {
      case SymbolKind.ClassFunction:
      case SymbolKind.ClassConstructor:
        classFunctions.set(key, s);
        break;
      case SymbolKind.ClassGetter:
        classGetters.set(key, s);
        break;
      case SymbolKind.ClassSetter:
        classSetters.set(key, s);
        break;
    }
  }
  const pluginByName = new Map<string, string>();
  for (const p of input.plugins) pluginByName.set(p.name.toLowerCase(), p.symbolId);
  // Map from constant/process-variable name → symbol id. Constants and
  // process variables share the bare-identifier syntax so they go through the
  // same resolver path; user constants take precedence on name collisions.
  const constantsByName = new Map<string, string>();
  for (const s of projectSymbols) {
    if (s.kind === SymbolKind.Constant || s.kind === SymbolKind.BuiltinConstant) {
      if (!constantsByName.has(s.name)) constantsByName.set(s.name, s.id);
    }
  }
  for (const s of projectSymbols) {
    if (s.kind === SymbolKind.ProcessVariable && !constantsByName.has(s.name)) {
      constantsByName.set(s.name, s.id);
    }
  }
  // Interprocess variables are matched separately because their canonical
  // reference syntax is `<>name`, distinct from bare identifiers.
  const interprocessByName = new Map<string, string>();
  for (const s of projectSymbols) {
    if (s.kind === SymbolKind.InterprocessVariable) {
      interprocessByName.set(s.name, s.id);
    }
  }
  // Project-wide Form symbols (TableForm names are scoped per table so
  // identifying them from a bare string is ambiguous — fall back if a
  // project-level Form matches).
  const formsByName = new Map<string, string>();
  for (const s of projectSymbols) {
    if (s.kind === SymbolKind.Form && !formsByName.has(s.name)) {
      formsByName.set(s.name, s.id);
    }
  }
  for (const s of projectSymbols) {
    if (s.kind === SymbolKind.TableForm && !formsByName.has(s.name)) {
      formsByName.set(s.name, s.id);
    }
  }

  const findOrCreateBuiltin = (name: string): string => {
    const id = symbolIdFor(SymbolKind.Builtin, name);
    if (!unresolvedSeen.has(id)) {
      unresolvedSeen.add(id);
      unresolved.push({
        id,
        name,
        kind: SymbolKind.Builtin,
        location: { uri: "", line: 0 }
      });
    }
    return id;
  };

  const findOrCreateUnresolved = (name: string): string => {
    const id = symbolIdFor(SymbolKind.Unresolved, name);
    if (!unresolvedSeen.has(id)) {
      unresolvedSeen.add(id);
      unresolved.push({
        id,
        name,
        kind: SymbolKind.Unresolved,
        location: { uri: "", line: 0 }
      });
    }
    return id;
  };

  // Walks the inheritance chain (extends) for a class and looks up a function name.
  const resolveOnClassChain = (className: string, method: string): SymbolRecord | undefined => {
    let cur: string | undefined = className;
    const visited = new Set<string>();
    while (cur && !visited.has(cur.toLowerCase())) {
      visited.add(cur.toLowerCase());
      const key = `${cur}.${method}`.toLowerCase();
      const f = classFunctions.get(key);
      if (f) return f;
      const cls = classByName.get(cur.toLowerCase());
      cur = cls?.extendsClass;
    }
    return undefined;
  };

  // Same, but walks for a `Function get name` accessor.
  const resolveGetterOnChain = (className: string, prop: string): SymbolRecord | undefined => {
    let cur: string | undefined = className;
    const visited = new Set<string>();
    while (cur && !visited.has(cur.toLowerCase())) {
      visited.add(cur.toLowerCase());
      const g = classGetters.get(`${cur}.${prop}`.toLowerCase());
      if (g) return g;
      const cls = classByName.get(cur.toLowerCase());
      cur = cls?.extendsClass;
    }
    return undefined;
  };

  // Same, but for `Function set name`.
  const resolveSetterOnChain = (className: string, prop: string): SymbolRecord | undefined => {
    let cur: string | undefined = className;
    const visited = new Set<string>();
    while (cur && !visited.has(cur.toLowerCase())) {
      visited.add(cur.toLowerCase());
      const s = classSetters.get(`${cur}.${prop}`.toLowerCase());
      if (s) return s;
      const cls = classByName.get(cur.toLowerCase());
      cur = cls?.extendsClass;
    }
    return undefined;
  };

  // Map a table name from the catalog to the user-defined class to look up
  // method calls on. Prefer the Entity class (the per-row API) since that's
  // what new()/get()/first() return; fall back to the DataClass class
  // (table-level API). Returns the canonical class name as stored.
  const classForTable = (tableName: string): string | undefined => {
    const entityCls = classByName.get(`${tableName}Entity`.toLowerCase());
    if (entityCls) return entityCls.name;
    const tableCls = classByName.get(tableName.toLowerCase());
    if (tableCls) return tableCls.name;
    return undefined;
  };

  // Variable type → class name (or undefined). Used by VarGet/VarSet/VarCall.
  const classFromVarType = (type: string | undefined): string | undefined => {
    if (!type) return undefined;
    const csMatch = type.match(/^cs\.([\w_]+)$/);
    if (csMatch) return csMatch[1];
    const esMatch = type.match(/^entitySelectionOf:([\w_]+)$/);
    if (esMatch) return esMatch[1];
    const dsTable = type.match(/^dsTable:([\w_]+)$/);
    if (dsTable) {
      if (input.catalogTables.has(dsTable[1])) {
        return classForTable(dsTable[1]) ?? dsTable[1];
      }
      return undefined;
    }
    const dsTableSel = type.match(/^dsTableSelection:([\w_]+)$/);
    if (dsTableSel && input.catalogTables.has(dsTableSel[1])) {
      return classForTable(dsTableSel[1]) ?? dsTableSel[1];
    }
    return undefined;
  };

  for (const parsed of input.files) {
    const localTypes = parsed.localTypes;
    const className = parsed.classInfo?.name;

    for (const call of parsed.rawCalls) {
      const hint = call.hint;
      if (!hint) continue;
      const pushEdge = (toId: string, kind: CallKind, resolved: boolean) => {
        edges.push({
          fromId: call.fromSymbolId,
          toId,
          callKind: kind,
          line: call.line,
          raw: call.expression,
          resolved
        });
      };

      switch (hint.kind) {
        case "BareName": {
          // Order: project method by name → builtin → unresolved
          const matches = byName.get(hint.name.toLowerCase()) ?? [];
          const method = matches.find(
            (s) =>
              s.kind === SymbolKind.ProjectMethod ||
              s.kind === SymbolKind.DatabaseMethod
          );
          if (method) {
            pushEdge(method.id, CallKind.Static, true);
          } else if (BUILTIN_SET.has(hint.name)) {
            pushEdge(findOrCreateBuiltin(hint.name), CallKind.Static, true);
          } else if (PLUGIN_PREFIXES.some((p) => hint.name.startsWith(p))) {
            // Plugin-like (e.g. HTTP_Get) — classify as builtin/plugin
            pushEdge(findOrCreateBuiltin(hint.name), CallKind.Static, true);
          } else {
            pushEdge(findOrCreateUnresolved(hint.name), CallKind.Dynamic, false);
          }
          break;
        }
        case "BuiltinChain": {
          if (BUILTIN_SET.has(hint.name)) {
            pushEdge(findOrCreateBuiltin(hint.name), CallKind.Static, true);
          }
          break;
        }
        case "CsNew": {
          const cls = classByName.get(hint.className.toLowerCase());
          if (cls) {
            const ctor = classFunctions.get(`${cls.name}.constructor`.toLowerCase());
            pushEdge(ctor?.id ?? cls.id, CallKind.Static, true);
          } else {
            pushEdge(findOrCreateUnresolved(`cs.${hint.className}.new`), CallKind.Dynamic, false);
          }
          break;
        }
        case "CsCall": {
          const fn = resolveOnClassChain(hint.className, hint.method);
          if (fn) {
            pushEdge(fn.id, CallKind.Static, true);
          } else {
            pushEdge(findOrCreateUnresolved(`cs.${hint.className}.${hint.method}`), CallKind.Dynamic, false);
          }
          break;
        }
        case "DsCall": {
          // ds.<DataClassName>.<fn>(...) — try classes named both DataClassName and singular Entity variants.
          const fn =
            resolveOnClassChain(hint.className, hint.method) ??
            classFunctions.get(`${hint.className}.${hint.method}`.toLowerCase());
          if (fn) {
            pushEdge(fn.id, CallKind.Static, true);
          } else {
            // Might be a built-in DataClass method like .query, .create, .all etc.
            pushEdge(findOrCreateBuiltin(`ds.${hint.className}.${hint.method}`), CallKind.Static, true);
          }
          break;
        }
        case "ThisCall": {
          if (className) {
            const fn = resolveOnClassChain(className, hint.method);
            if (fn) {
              pushEdge(fn.id, fn.ownerClass === className ? CallKind.Static : CallKind.Inherited, true);
              break;
            }
          }
          pushEdge(findOrCreateUnresolved(`This.${hint.method}`), CallKind.Dynamic, false);
          break;
        }
        case "SuperCall": {
          if (className && parsed.classInfo?.extends) {
            const m = hint.method ?? "constructor";
            const fn = resolveOnClassChain(parsed.classInfo.extends, m);
            if (fn) {
              pushEdge(fn.id, CallKind.Inherited, true);
              break;
            }
          }
          pushEdge(findOrCreateUnresolved("Super"), CallKind.Dynamic, false);
          break;
        }
        case "VarCall": {
          const locals = localTypes.get(call.fromSymbolId);
          const targetClass = classFromVarType(locals?.get(hint.variable));
          if (targetClass) {
            const fn = resolveOnClassChain(targetClass, hint.method);
            if (fn) {
              pushEdge(fn.id, CallKind.Static, true);
            } else {
              pushEdge(findOrCreateBuiltin(`${targetClass}.${hint.method}`), CallKind.Static, true);
            }
            break;
          }
          pushEdge(findOrCreateUnresolved(`$${hint.variable}.${hint.method}`), CallKind.Dynamic, false);
          break;
        }
        case "CallWorker":
        case "NewProcess":
        case "ExecuteMethodLiteral": {
          const matches = byName.get(hint.methodName.toLowerCase()) ?? [];
          const method = matches.find((s) => s.kind === SymbolKind.ProjectMethod || s.kind === SymbolKind.DatabaseMethod);
          if (method) pushEdge(method.id, CallKind.Dynamic, true);
          else pushEdge(findOrCreateUnresolved(hint.methodName), CallKind.Dynamic, false);
          break;
        }
        case "ExecuteMethodDynamic": {
          pushEdge(findOrCreateUnresolved(`EXECUTE_METHOD($${hint.variable})`), CallKind.Dynamic, false);
          break;
        }
        case "ExecuteMethodInSubform": {
          const matches = byName.get(`${hint.formName}.${hint.methodName}`.toLowerCase()) ?? [];
          const method = matches[0];
          if (method) pushEdge(method.id, CallKind.Dynamic, true);
          else pushEdge(findOrCreateUnresolved(`${hint.formName}.${hint.methodName}`), CallKind.Dynamic, false);
          break;
        }
        case "Formula": {
          // The body's calls were already extracted by callExtractor.
          break;
        }
        case "ThisGet": {
          if (!className) break;
          const g = resolveGetterOnChain(className, hint.property);
          if (g) {
            pushEdge(g.id, g.ownerClass === className ? CallKind.Static : CallKind.Inherited, true);
          }
          // Drop unresolved silently: it's likely a plain `property`, not a computed accessor.
          break;
        }
        case "ThisSet": {
          if (!className) break;
          const s = resolveSetterOnChain(className, hint.property);
          if (s) {
            pushEdge(s.id, s.ownerClass === className ? CallKind.Static : CallKind.Inherited, true);
          }
          break;
        }
        case "VarGet": {
          const locals = localTypes.get(call.fromSymbolId);
          const target = classFromVarType(locals?.get(hint.variable));
          if (!target) break;
          const g = resolveGetterOnChain(target, hint.property);
          if (g) pushEdge(g.id, CallKind.Static, true);
          break;
        }
        case "VarSet": {
          const locals = localTypes.get(call.fromSymbolId);
          const target = classFromVarType(locals?.get(hint.variable));
          if (!target) break;
          const s = resolveSetterOnChain(target, hint.property);
          if (s) pushEdge(s.id, CallKind.Static, true);
          break;
        }
        case "CsGet": {
          const g = resolveGetterOnChain(hint.className, hint.property);
          if (g) pushEdge(g.id, CallKind.Static, true);
          break;
        }
        case "CsSet": {
          const s = resolveSetterOnChain(hint.className, hint.property);
          if (s) pushEdge(s.id, CallKind.Static, true);
          break;
        }
        case "DsBracketNew": {
          // Also count this as a usage of the bracket identifier (typically
          // a table-name constant like `_Rules`) so the constant's caller
          // tree includes every ds[_X] site.
          const cid = constantsByName.get(hint.ident);
          if (cid) pushEdge(cid, CallKind.Static, true);
          // Strip the conventional leading underscore (`_Rules` → `Rules`)
          // then verify the table exists in the catalog.
          const table = hint.ident.replace(/^_/, "");
          if (!input.catalogTables.has(table)) {
            pushEdge(findOrCreateUnresolved(`ds[${hint.ident}].new`), CallKind.Dynamic, false);
            break;
          }
          const targetClass = classForTable(table);
          if (targetClass) {
            const ctor = classFunctions.get(`${targetClass}.constructor`.toLowerCase());
            const target = ctor ?? classByName.get(targetClass.toLowerCase());
            if (target) {
              pushEdge(target.id, CallKind.Static, true);
              break;
            }
          }
          // No user-defined class — synthesize a builtin to keep the edge.
          pushEdge(findOrCreateBuiltin(`ds.${table}.new`), CallKind.Static, true);
          break;
        }
        case "DsBracketCall": {
          const cid = constantsByName.get(hint.ident);
          if (cid) pushEdge(cid, CallKind.Static, true);
          const table = hint.ident.replace(/^_/, "");
          if (!input.catalogTables.has(table)) {
            pushEdge(findOrCreateUnresolved(`ds[${hint.ident}].${hint.method}`), CallKind.Dynamic, false);
            break;
          }
          const targetClass = classForTable(table);
          const fn = targetClass ? resolveOnClassChain(targetClass, hint.method) : undefined;
          if (fn) {
            pushEdge(fn.id, CallKind.Static, true);
          } else {
            pushEdge(findOrCreateBuiltin(`ds.${table}.${hint.method}`), CallKind.Static, true);
          }
          break;
        }
        case "ConstantRef": {
          // Only emit if the bare identifier resolves to a known constant or
          // process variable. Drop silently otherwise — most identifiers in
          // method bodies are local helpers, not globals.
          const id = constantsByName.get(hint.name);
          if (id) pushEdge(id, CallKind.Static, true);
          break;
        }
        case "InterprocessRef": {
          const id = interprocessByName.get(hint.name);
          if (id) pushEdge(id, CallKind.Static, true);
          break;
        }
        case "FormRef": {
          const id = formsByName.get(hint.formName);
          if (id) pushEdge(id, CallKind.Static, true);
          break;
        }
        case "FormRefDynamic": {
          // Look up the variable's literal value in the per-method strings
          // table — intra-method scope only. Skip silently if the variable
          // wasn't assigned a string literal in the same method body.
          const literals = parsed.localStrings?.get(call.fromSymbolId);
          const formName = literals?.get(hint.variable);
          if (!formName) break;
          const id = formsByName.get(formName);
          if (id) pushEdge(id, CallKind.Dynamic, true);
          break;
        }
        case "ProjectMethodBare": {
          // A bare identifier on its own line — 4D's parenthesis-less call form.
          // Emit an edge ONLY if a real project method (or database method) with
          // that name exists. Drops silently otherwise so unknown identifiers
          // don't become Unresolved noise.
          const matches = byName.get(hint.name.toLowerCase()) ?? [];
          const method = matches.find(
            (s) => s.kind === SymbolKind.ProjectMethod || s.kind === SymbolKind.DatabaseMethod
          );
          if (method) pushEdge(method.id, CallKind.Static, true);
          break;
        }
      }
    }
  }

  // Deduplicate identical edges (same from/to/line)
  const seen = new Set<string>();
  const uniq: CallEdge[] = [];
  for (const e of edges) {
    const key = `${e.fromId}|${e.toId}|${e.line}|${e.callKind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(e);
  }
  return { edges: uniq, unresolvedSymbols: unresolved };
}

export function buildSymbolIndex(
  projectRoot: string,
  parsedFiles: ParsedFile[],
  plugins: { name: string; absolutePath: string }[],
  catalogTables: Set<string> = new Set(),
  constants: { name: string; value?: string; type?: string; theme?: string; sourceFile: string }[] = [],
  builtinConstants: { name: string; value?: string; theme?: string; sourceFile: string }[] = [],
  variables: { name: string; scope: "process" | "interprocess"; type?: string; sourceFile: string; line: number }[] = []
): SymbolIndex {
  const allSymbols: SymbolRecord[] = [];
  for (const f of parsedFiles) {
    for (const s of f.symbols) allSymbols.push(s);
  }
  const pluginSyms = plugins.map((p) => ({
    id: symbolIdFor(SymbolKind.Plugin, p.name),
    name: p.name,
    kind: SymbolKind.Plugin,
    location: { uri: "file://" + p.absolutePath, line: 0 }
  }));
  for (const s of pluginSyms) allSymbols.push(s);

  // User-defined constants from Resources/Constants_*.xlf. Name-only symbols
  // with no edges by default — refs are tracked separately via the ConstantRef
  // hint and emitted only when the bare identifier matches a known constant.
  const seenConstants = new Set<string>();
  for (const c of constants) {
    const id = symbolIdFor(SymbolKind.Constant, c.name);
    if (seenConstants.has(id)) continue;
    seenConstants.add(id);
    allSymbols.push({
      id,
      name: c.name,
      kind: SymbolKind.Constant,
      location: { uri: "file://" + c.sourceFile, line: 0 },
      constantValue: c.value,
      constantType: c.type,
      constantTheme: c.theme
    });
  }

  // Process + interprocess variables harvested from C_TYPE / ARRAY TYPE /
  // `var` declarations across Methods/ and DatabaseMethods/. No edges — they
  // populate the Symbols view so the user can browse the project's globals.
  const seenVariables = new Set<string>();
  for (const v of variables) {
    const kind = v.scope === "interprocess" ? SymbolKind.InterprocessVariable : SymbolKind.ProcessVariable;
    const id = symbolIdFor(kind, v.name);
    if (seenVariables.has(id)) continue;
    seenVariables.add(id);
    allSymbols.push({
      id,
      name: v.name,
      kind,
      location: { uri: "file://" + v.sourceFile, line: v.line },
      variableType: v.type
    });
  }

  // 4D built-in constants from the tool4d / 4D installation's 4D_ConstantsEN.xlf.
  // Kept under a separate kind so they don't clutter the user-constants group.
  const seenBuiltinConstants = new Set<string>();
  for (const c of builtinConstants) {
    const id = symbolIdFor(SymbolKind.BuiltinConstant, c.name);
    if (seenBuiltinConstants.has(id)) continue;
    // Don't shadow a user constant of the same name.
    if (seenConstants.has(symbolIdFor(SymbolKind.Constant, c.name))) continue;
    seenBuiltinConstants.add(id);
    allSymbols.push({
      id,
      name: c.name,
      kind: SymbolKind.BuiltinConstant,
      location: { uri: "file://" + c.sourceFile, line: 0 },
      constantValue: c.value,
      constantTheme: c.theme
    });
  }

  const { edges, unresolvedSymbols } = resolve(
    {
      files: parsedFiles,
      plugins: pluginSyms.map((s) => ({ name: s.name, symbolId: s.id })),
      catalogTables
    },
    allSymbols
  );

  for (const u of unresolvedSymbols) allSymbols.push(u);

  return {
    version: INDEX_VERSION,
    builtAt: Date.now(),
    projectRoot,
    symbols: allSymbols,
    edges,
    fileMtimes: {}
  };
}
