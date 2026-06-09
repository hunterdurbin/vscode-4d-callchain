import { CallEdge, CallKind, ClassFlavor, INDEX_VERSION, RawCallSite, SymbolIndex, SymbolKind, SymbolRecord, symbolIdFor } from "../model/symbol";
import { ParsedFile } from "./fileParser";
import builtinsData from "../model/builtins.json";
import {
  BUILTIN_TYPE_API,
  BUILTIN_TYPE_BASES,
  PARAM_ENTITY,
  PARAM_SELECTION,
  splitBuiltin
} from "./builtinTypeApi";

/**
 * Read-only set of every command the indexer treats as "built into 4D":
 * the bundled command catalog (~1300 entries from `model/builtins.json`)
 * plus the legacy `C_*` / `ARRAY` declarations that pre-date the typed-
 * `var` syntax. Exported via `@4d/core` so the lint package can detect
 * user-defined symbols whose name collides with a built-in.
 */
export const BUILTIN_SET = new Set<string>((builtinsData as any).commands);
const PLUGIN_PREFIXES: string[] = (builtinsData as any).pluginCommandPrefixes ?? [];

// Legacy 4D type-declaration commands that pre-date the typed-`var` syntax.
// They live outside the modern command catalog but are still valid in v21 and
// appear in nearly every legacy file. Without this fallback, diagnostics
// would flag tens of thousands of `C_LONGINT(...)` / `C_TEXT(...)` lines.
const LEGACY_TYPE_COMMANDS = [
  "C_LONGINT", "C_INTEGER", "C_TEXT", "C_STRING", "C_REAL", "C_BOOLEAN",
  "C_DATE", "C_TIME", "C_BLOB", "C_PICTURE", "C_OBJECT", "C_COLLECTION",
  "C_POINTER", "C_GRAPH", "C_VARIANT", "ARRAY", "VARIABLE"
];
for (const cmd of LEGACY_TYPE_COMMANDS) BUILTIN_SET.add(cmd);

export interface ResolverInput {
  files: ParsedFile[];
  plugins: { name: string; symbolId: string; commands?: string[] }[];
  /** Catalog table names from `Project/Sources/Catalog/Tables/*.json`. */
  catalogTables: Set<string>;
  /** Method name → Component symbol id (from each component's methodAttributes.json). */
  componentByMethod?: Map<string, string>;
  /**
   * Component class property types, keyed by lowercase `cs.<ns>.<class>`.
   * Each value maps a property name to the fully-qualified `cs.<ns>.<class>`
   * type the property holds. Used by VarChainCall to walk `$x.prop.method()`.
   */
  componentClassPropsByNs?: Map<string, Map<string, string>>;
  /**
   * Project class property types, keyed by lowercase class name. Each value
   * maps a property/getter name to its declared type string (`cs.Foo`,
   * `cs.NS.Bar`, or a primitive that won't be resolvable further).
   */
  projectClassPropsByName?: Map<string, Map<string, string>>;
  /**
   * Project class method return types, keyed by lowercase class name. Lets
   * the chain walker advance through mid-chain method calls like
   * `$x.findById($id).save()`.
   */
  projectClassMethodReturnsByName?: Map<string, Map<string, string>>;
}

export interface ResolverOutput {
  edges: CallEdge[];
  unresolvedSymbols: SymbolRecord[];
  /**
   * For each parsed file (keyed by `absolutePath`), the set of synthetic
   * symbol ids that file contributed to. Lets the incremental indexer reverse
   * the contribution on file change/delete and drop synths whose refcount
   * reaches zero.
   */
  synthOwnersByPath: Map<string, Set<string>>;
}

/**
 * Bundle of lookup maps + helper closures shared across the per-file loop.
 * Built once per `resolve()` invocation (full rebuild) or per patch (incremental).
 * The synth-creation closures (`findOrCreateBuiltin` etc.) mutate `unresolved`
 * + `unresolvedSeen` so symbols accumulate across files. Helpers that close
 * over `input` (`stepProperty`, `stepMethodReturn`, `classFromVarType`) get
 * fresh closures bound to the current `input` reference.
 */
export interface ResolverScratch {
  input: ResolverInput;
  // Lookup maps
  byName: Map<string, SymbolRecord[]>;
  classByName: Map<string, SymbolRecord>;
  componentClassByNs: Map<string, SymbolRecord>;
  classFunctions: Map<string, SymbolRecord>;
  classGetters: Map<string, SymbolRecord>;
  classSetters: Map<string, SymbolRecord>;
  classAliases: Map<string, SymbolRecord>;
  pluginByName: Map<string, string>;
  commandToPlugin: Map<string, string>;
  constantsByName: Map<string, string>;
  interprocessByName: Map<string, string>;
  formsByName: Map<string, string>;
  // Synth-symbol state. `unresolved` is appended to; `unresolvedSeen`
  // dedupes ids; `synthOwnersByPath` attributes each synth's contribution
  // to the file that created it (needed for incremental refcount).
  unresolved: SymbolRecord[];
  unresolvedSeen: Set<string>;
  synthOwnersByPath: Map<string, Set<string>>;
  // Synth creators. The currently-resolving file's absolute path is
  // configured via `setCurrentFileOrigin` so call sites don't have to
  // thread the path through. The creators read it at invocation time and
  // attribute the synth to that file (for incremental refcounting).
  setCurrentFileOrigin: (absolutePath: string | undefined) => void;
  findOrCreateBuiltin: (name: string) => string;
  findOrCreateTableBuiltin: (table: string, method: string) => string;
  findOrCreateUnresolved: (name: string) => string;
  // Class chain resolvers
  resolveOnClassChain: (className: string, method: string) => SymbolRecord | undefined;
  resolveGetterOnChain: (className: string, prop: string) => SymbolRecord | undefined;
  resolveSetterOnChain: (className: string, prop: string) => SymbolRecord | undefined;
  resolveAliasOnChain: (className: string, prop: string) => SymbolRecord | undefined;
  classForTable: (tableName: string) => string | undefined;
  normalizeType: (type: string | undefined) => string | undefined;
  stepProperty: (type: string, prop: string) => string | undefined;
  stepMethodReturn: (type: string, method: string) => string | undefined;
  builtinBaseOf: (type: string) => string | undefined;
  builtinMethodName: (type: string, method: string) => string | undefined;
  classFromVarType: (type: string | undefined) => string | undefined;
  resolveMethodOnType: (type: string, method: string) => SymbolRecord | undefined;
  resolveMethodOrBuiltin: (type: string, method: string) => { id: string; resolved: boolean } | undefined;
}

export function resolve(input: ResolverInput, projectSymbols: SymbolRecord[]): ResolverOutput {
  const scratch = buildResolverScratch(input, projectSymbols);
  const allEdges: CallEdge[] = [];
  for (const parsed of input.files) {
    const fileEdges = resolveCallsForFile(parsed, scratch);
    for (const e of fileEdges) allEdges.push(e);
  }
  // Project-wide dedup. Per-file dedup happens in `resolveCallsForFile`, but
  // identical edges can still arise across files when two files own symbols
  // with the same id (rare; preserved for backward compatibility).
  const seen = new Set<string>();
  const uniq: CallEdge[] = [];
  for (const e of allEdges) {
    const key = `${e.fromId}|${e.toId}|${e.line}|${e.callKind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(e);
  }
  return {
    edges: uniq,
    unresolvedSymbols: scratch.unresolved,
    synthOwnersByPath: scratch.synthOwnersByPath
  };
}

/**
 * Build the lookup maps + helper closures over `projectSymbols`. The returned
 * scratch is re-usable across multiple per-file resolves for a single patch.
 */
export function buildResolverScratch(input: ResolverInput, projectSymbols: SymbolRecord[]): ResolverScratch {
  const unresolved: SymbolRecord[] = [];
  const unresolvedSeen = new Set<string>();
  const unresolvedById = new Map<string, SymbolRecord>();
  const synthOwnersByPath = new Map<string, Set<string>>();

  // Build indexes for fast lookup.
  const byName = new Map<string, SymbolRecord[]>();
  const classByName = new Map<string, SymbolRecord>();
  // Component classes are keyed by their fully-qualified `cs.<ns>.<class>`
  // identifier (lowercase) — keeps them out of the bare-name classByName map
  // so a project class named `Testing` and a component class named `Testing`
  // don't collide.
  const componentClassByNs = new Map<string, SymbolRecord>();
  for (const s of projectSymbols) {
    const key = s.name.toLowerCase();
    const arr = byName.get(key) ?? [];
    arr.push(s);
    byName.set(key, arr);
    if (s.kind === SymbolKind.Class) {
      if (s.ownerComponent) {
        const nsKey = s.id.replace(/^Class:/, "").toLowerCase();
        componentClassByNs.set(nsKey, s);
      } else {
        classByName.set(s.name.toLowerCase(), s);
      }
    }
  }
  const classFunctions = new Map<string, SymbolRecord>(); // key: className.fnName (lowercase)
  const classGetters   = new Map<string, SymbolRecord>(); // key: className.propName (lowercase)
  const classSetters   = new Map<string, SymbolRecord>(); // key: className.propName (lowercase)
  const classAliases   = new Map<string, SymbolRecord>(); // key: className.aliasName (lowercase)
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
      case SymbolKind.Alias:
        classAliases.set(key, s);
        break;
    }
  }
  const pluginByName = new Map<string, string>();
  for (const p of input.plugins) pluginByName.set(p.name.toLowerCase(), p.symbolId);
  // Command name → PluginCommand symbol id (each command from each plugin's
  // manifest is its own first-class symbol). Bare-name / multi-word matches
  // consult this BEFORE the generic Builtin fallback.
  const commandToPlugin = new Map<string, string>();
  for (const s of projectSymbols) {
    if (s.kind === SymbolKind.PluginCommand && !commandToPlugin.has(s.name)) {
      commandToPlugin.set(s.name, s.id);
    }
  }
  // Map from constant/process-variable name → symbol id. Constants and
  // process variables share the bare-identifier syntax so they go through the
  // same resolver path; user constants take precedence on name collisions.
  // 4D identifiers are case-insensitive so all keys are lowercased; callers
  // must do the same on lookup.
  const constantsByName = new Map<string, string>();
  for (const s of projectSymbols) {
    if (s.kind === SymbolKind.Constant || s.kind === SymbolKind.BuiltinConstant) {
      const key = s.name.toLowerCase();
      if (!constantsByName.has(key)) constantsByName.set(key, s.id);
    }
  }
  for (const s of projectSymbols) {
    if (s.kind === SymbolKind.ProcessVariable) {
      const key = s.name.toLowerCase();
      if (!constantsByName.has(key)) constantsByName.set(key, s.id);
    }
  }
  // Interprocess variables are matched separately because their canonical
  // reference syntax is `<>name`, distinct from bare identifiers.
  const interprocessByName = new Map<string, string>();
  for (const s of projectSymbols) {
    if (s.kind === SymbolKind.InterprocessVariable) {
      interprocessByName.set(s.name.toLowerCase(), s.id);
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

  // Tracked across synth-creator invocations so incremental indexing can
  // reverse a file's contribution without re-scanning the entire edge set.
  // The per-file resolver sets this via setCurrentFileOrigin before
  // iterating a ParsedFile's rawCalls.
  let currentFileOrigin: string | undefined;
  const setCurrentFileOrigin = (absolutePath: string | undefined): void => {
    currentFileOrigin = absolutePath;
  };

  // Maintain the symbol's `fileOrigins[]` AND the per-file `synthOwnersByPath`
  // index in lock-step. Calls that don't have a fileOrigin (theoretically none
  // in normal use) are silently skipped — synth symbols missing a fileOrigin
  // would never be reclaimed, but that's the same behaviour as before.
  const recordSynthOwner = (id: string, sym: SymbolRecord): void => {
    if (!currentFileOrigin) return;
    let owners = synthOwnersByPath.get(currentFileOrigin);
    if (!owners) {
      owners = new Set();
      synthOwnersByPath.set(currentFileOrigin, owners);
    }
    if (owners.has(id)) return;
    owners.add(id);
    const list = sym.fileOrigins ?? (sym.fileOrigins = []);
    if (!list.includes(currentFileOrigin)) list.push(currentFileOrigin);
  };

  const findOrCreateBuiltin = (name: string): string => {
    const id = symbolIdFor(SymbolKind.Builtin, name);
    let sym = unresolvedById.get(id);
    if (!unresolvedSeen.has(id)) {
      unresolvedSeen.add(id);
      sym = {
        id,
        name,
        kind: SymbolKind.Builtin,
        location: { uri: "", line: 0 }
      };
      unresolved.push(sym);
      unresolvedById.set(id, sym);
    }
    if (sym) recordSynthOwner(id, sym);
    return id;
  };

  /**
   * Synthetic per-table ORDA call symbol (`ds.<Table>.<method>` style).
   * Kept in its own SymbolKind so the tree provider can give them a
   * dedicated `Table Builtin` folder rather than mixing them in with
   * actual 4D commands.
   */
  const findOrCreateTableBuiltin = (table: string, method: string): string => {
    const name = `ds.${table}.${method}`;
    const id = symbolIdFor(SymbolKind.TableBuiltin, name);
    let sym = unresolvedById.get(id);
    if (!unresolvedSeen.has(id)) {
      unresolvedSeen.add(id);
      sym = {
        id,
        name,
        kind: SymbolKind.TableBuiltin,
        location: { uri: "", line: 0 },
        ownerTable: table
      };
      unresolved.push(sym);
      unresolvedById.set(id, sym);
    }
    if (sym) recordSynthOwner(id, sym);
    return id;
  };

  const findOrCreateUnresolved = (name: string): string => {
    const id = symbolIdFor(SymbolKind.Unresolved, name);
    let sym = unresolvedById.get(id);
    if (!unresolvedSeen.has(id)) {
      unresolvedSeen.add(id);
      sym = {
        id,
        name,
        kind: SymbolKind.Unresolved,
        location: { uri: "", line: 0 }
      };
      unresolved.push(sym);
      unresolvedById.set(id, sym);
    }
    if (sym) recordSynthOwner(id, sym);
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

  // Same, but for `Alias name target` attributes. An alias is read/write like
  // a field, so both property reads and writes of an alias name resolve here.
  const resolveAliasOnChain = (className: string, prop: string): SymbolRecord | undefined => {
    let cur: string | undefined = className;
    const visited = new Set<string>();
    while (cur && !visited.has(cur.toLowerCase())) {
      visited.add(cur.toLowerCase());
      const a = classAliases.get(`${cur}.${prop}`.toLowerCase());
      if (a) return a;
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

  /**
   * Normalize a type string captured from a `var`/`property`/param declaration
   * into a canonical chain-walker form. Resolved forms:
   *   - `cs.<NS>.<Class>` (component class — unchanged)
   *   - `<ClassName>` (project class — bare name)
   *   - `EntitySelection<EntityClass>` (parametric ORDA selection)
   *   - `Collection`, `Object`, `Date`, `Time`, `Number`, `Text`, `Boolean`,
   *     `Picture`, `Blob`, `Formula` (canonical builtin scalars / containers)
   *   - `undefined` for unknown / not chainable types
   */
  const normalizeType = (type: string | undefined): string | undefined => {
    if (!type) return undefined;
    if (/^cs\.[\w_]+\.[\w_]+$/.test(type)) return type;
    const csMatch = type.match(/^cs\.([\w_]+)$/);
    if (csMatch) {
      const name = csMatch[1];
      if (classByName.has(name.toLowerCase())) return name;
      return undefined;
    }
    // ORDA selection tokens emitted by fileParser.
    const esMatch = type.match(/^entitySelectionOf:([\w_]+)$/) ?? type.match(/^dsTableSelection:([\w_]+)$/);
    if (esMatch) {
      const entityCls = classForTable(esMatch[1]) ?? esMatch[1];
      return `EntitySelection<${entityCls}>`;
    }
    // ORDA entity tokens — ds[_Foo].new()/.get()/.first()/.last() and ds.Foo.new()/.get().
    const dsTable = type.match(/^dsTable:([\w_]+)$/);
    if (dsTable) {
      return classForTable(dsTable[1]) ?? (classByName.has(dsTable[1].toLowerCase()) ? dsTable[1] : undefined);
    }
    // Already-canonical parametric form (propagated through a chain step).
    if (/^EntitySelection<[\w_]+>$/.test(type)) return type;
    // Project class.
    if (classByName.has(type.toLowerCase())) return type;
    // Primitive 4D types — fold to the bases the builtin API indexes on.
    const primMap: Record<string, string> = {
      Integer: "Number", Longint: "Number", Real: "Number", Numeric: "Number", Number: "Number",
      Alpha: "Text", Text: "Text", String: "Text",
      Boolean: "Boolean", Bool: "Boolean",
      Date: "Date", Time: "Time",
      Collection: "Collection", Object: "Object",
      Picture: "Picture", Blob: "Blob", Formula: "Formula"
    };
    if (primMap[type]) return primMap[type];
    return undefined;
  };

  /** Step one property/getter on the current type; return the next normalized type or undefined. */
  const stepProperty = (type: string, prop: string): string | undefined => {
    // Component class — look up in componentClassPropsByNs.
    if (/^cs\.[\w_]+\.[\w_]+$/.test(type)) {
      const next = input.componentClassPropsByNs?.get(type.toLowerCase())?.get(prop);
      return next ? normalizeType(next) : undefined;
    }
    // Project class — walk the inheritance chain looking for the property.
    let cur: string | undefined = type;
    const visited = new Set<string>();
    while (cur && !visited.has(cur.toLowerCase())) {
      visited.add(cur.toLowerCase());
      const next = input.projectClassPropsByName?.get(cur.toLowerCase())?.get(prop);
      if (next) return normalizeType(next);
      cur = classByName.get(cur.toLowerCase())?.extendsClass;
    }
    return undefined;
  };

  /**
   * Step one method-call on the current type; return the method's return type
   * (normalized) or undefined. Sources, in order:
   *   1. Project class function return types (Pass 3 user-class metadata)
   *   2. Typed getters acting like methods (`$x.foo()` when foo is a getter)
   *   3. Built-in type API (Collection, ORDA, Date, ...)
   */
  const stepMethodReturn = (type: string, method: string): string | undefined => {
    // Component classes have no usable return-type metadata from classes.json today.
    if (/^cs\.[\w_]+\.[\w_]+$/.test(type)) return undefined;
    // Class-based: walk inheritance.
    let cur: string | undefined = type;
    const visited = new Set<string>();
    while (cur && !visited.has(cur.toLowerCase())) {
      visited.add(cur.toLowerCase());
      const ret = input.projectClassMethodReturnsByName?.get(cur.toLowerCase())?.get(method);
      if (ret) return normalizeType(ret);
      const propType = input.projectClassPropsByName?.get(cur.toLowerCase())?.get(method);
      if (propType) return normalizeType(propType);
      cur = classByName.get(cur.toLowerCase())?.extendsClass;
    }
    // Builtin types (Collection, EntitySelection<T>, Object, ...).
    const builtinRet = stepBuiltinReturn(type, method);
    if (builtinRet !== undefined) return normalizeType(builtinRet);
    return undefined;
  };

  /**
   * Look up `<typeBase>.<method>` in the built-in API table. Resolves
   * parametric sentinels (PARAM_ENTITY / PARAM_SELECTION) against the
   * parameter carried by the input type (e.g. `EntitySelection<Foo>` →
   * Foo on first(), `EntitySelection<Foo>` on query()). For project
   * classes with a flavored base (Entity/EntitySelection/DataClass) the
   * parameter is the class name itself.
   */
  const stepBuiltinReturn = (type: string, method: string): string | undefined => {
    const parts = splitBuiltin(type);
    let base = parts && BUILTIN_TYPE_BASES.has(parts.base) ? parts.base : undefined;
    let param = parts?.param;
    if (!base) {
      const flavorBase = builtinBaseOf(type);
      if (flavorBase) {
        base = flavorBase;
        // Project Entity class → param is the class itself (so .getSelection()
        // returns `EntitySelection<<EntityClass>>`).
        param = type;
      }
    }
    if (!base) return undefined;
    const api = BUILTIN_TYPE_API[base];
    if (!api) return undefined;
    const ret = api[method];
    if (ret === undefined || ret === "") return undefined;
    if (ret === PARAM_ENTITY) return param;
    if (ret === PARAM_SELECTION) return param ? `EntitySelection<${param}>` : "EntitySelection";
    return ret;
  };

  /**
   * Map a chain-walker type string to its implicit builtin base (if any).
   * Project classes inherit Entity / EntitySelection / DataClass behaviour
   * from their inheritance chain so a `$entity.save()` call routes to
   * `Builtin:Entity.save` instead of a per-class synthetic symbol.
   *
   * Walks the full `extends` chain — a class `MyEntity extends BaseEntity
   * extends Entity` correctly resolves to `Entity`. Stops at the first class
   * whose flavor is set OR whose `extendsClass` literal is a builtin name.
   */
  const builtinBaseOf = (type: string): string | undefined => {
    const parts = splitBuiltin(type);
    if (parts && BUILTIN_TYPE_BASES.has(parts.base)) return parts.base;
    let cur: string | undefined = type;
    const visited = new Set<string>();
    while (cur && !visited.has(cur.toLowerCase())) {
      visited.add(cur.toLowerCase());
      const cls = classByName.get(cur.toLowerCase());
      if (!cls) return undefined;
      switch (cls.classFlavor) {
        case ClassFlavor.Entity: return "Entity";
        case ClassFlavor.EntitySelection: return "EntitySelection";
        case ClassFlavor.DataClass: return "DataClass";
        case ClassFlavor.DataStore: return "DataClass";
        default: break;
      }
      // Also catch the case where the immediate `extends` literal is itself
      // a builtin name — classifyFlavor only sets the flavor for direct
      // extends; intermediate user classes leave it Generic.
      const ec = cls.extendsClass;
      if (ec === "Entity") return "Entity";
      if (ec === "EntitySelection") return "EntitySelection";
      if (ec === "DataClass") return "DataClass";
      if (ec === "DataStore" || ec === "DataStoreImplementation") return "DataClass";
      cur = ec;
    }
    return undefined;
  };

  /**
   * Synthetic Builtin symbol id for a `<typeBase>.<method>` call. Used as
   * the fallback edge target when a method call resolves to a builtin
   * type's API rather than to a user/component class function.
   */
  const builtinMethodName = (type: string, method: string): string | undefined => {
    const base = builtinBaseOf(type);
    if (!base) return undefined;
    const api = BUILTIN_TYPE_API[base];
    if (!api || api[method] === undefined) return undefined;
    return `${base}.${method}`;
  };

  /** Render a chain path for an unresolved-edge label: ".foo().bar" etc. */
  const pathLabel = (path: { name: string; isCall: boolean }[]): string =>
    path.map((s) => (s.isCall ? `${s.name}()` : s.name)).join(".");

  /**
   * Attempt to attribute `<type>.<method>` to a real ClassFunction symbol
   * first; on miss, fall back to a Builtin synthetic symbol if the type
   * has an entry in BUILTIN_TYPE_API. Returns undefined if nothing matches.
   */
  const resolveMethodOrBuiltin = (type: string, method: string): { id: string; resolved: boolean } | undefined => {
    const fn = resolveMethodOnType(type, method);
    if (fn) return { id: fn.id, resolved: true };
    const bname = builtinMethodName(type, method);
    if (bname) return { id: findOrCreateBuiltin(bname), resolved: true };
    return undefined;
  };

  /** Resolve `<type>.<method>` to a ClassFunction symbol, or undefined. */
  const resolveMethodOnType = (type: string, method: string): SymbolRecord | undefined => {
    if (/^cs\.[\w_]+\.[\w_]+$/.test(type)) {
      return classFunctions.get(`${type}.${method}`.toLowerCase());
    }
    return resolveOnClassChain(type, method);
  };

  // Variable type → class name (or undefined). Used by VarGet/VarSet/VarCall.
  // Returns either a bare class name (`Foo`) for project classes or the fully
  // qualified `cs.<ns>.<class>` form for component classes — the resolveOnClassChain
  // lookup keys ClassFunction entries by `ownerClass` so both forms work.
  const classFromVarType = (type: string | undefined): string | undefined => {
    if (!type) return undefined;
    // Component-class type: `cs.<ns>.<Class>`
    const csNsMatch = type.match(/^cs\.([\w_]+)\.([\w_]+)$/);
    if (csNsMatch && componentClassByNs.has(`cs.${csNsMatch[1]}.${csNsMatch[2]}`.toLowerCase())) {
      return `cs.${csNsMatch[1]}.${csNsMatch[2]}`;
    }
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

  return {
    input,
    byName,
    classByName,
    componentClassByNs,
    classFunctions,
    classGetters,
    classSetters,
    classAliases,
    pluginByName,
    commandToPlugin,
    constantsByName,
    interprocessByName,
    formsByName,
    unresolved,
    unresolvedSeen,
    synthOwnersByPath,
    setCurrentFileOrigin,
    findOrCreateBuiltin,
    findOrCreateTableBuiltin,
    findOrCreateUnresolved,
    resolveOnClassChain,
    resolveGetterOnChain,
    resolveSetterOnChain,
    resolveAliasOnChain,
    classForTable,
    normalizeType,
    stepProperty,
    stepMethodReturn,
    builtinBaseOf,
    builtinMethodName,
    classFromVarType,
    resolveMethodOnType,
    resolveMethodOrBuiltin
  };
}

/**
 * Resolve the rawCalls of a single ParsedFile against the supplied scratch,
 * mutating the scratch's `unresolved` / `synthOwnersByPath` state as new
 * synthetic targets are created. Returns the file's edges, deduplicated
 * within the file by `(fromId, toId, line, callKind)`.
 */
export function resolveCallsForFile(parsed: ParsedFile, scratch: ResolverScratch): CallEdge[] {
  const {
    input,
    byName,
    classByName,
    componentClassByNs,
    classFunctions,
    classGetters,
    classSetters,
    commandToPlugin,
    constantsByName,
    interprocessByName,
    formsByName,
    setCurrentFileOrigin,
    findOrCreateBuiltin,
    findOrCreateTableBuiltin,
    findOrCreateUnresolved,
    resolveOnClassChain,
    resolveGetterOnChain,
    resolveSetterOnChain,
    resolveAliasOnChain,
    classForTable,
    normalizeType,
    stepProperty,
    stepMethodReturn,
    builtinMethodName,
    classFromVarType,
    resolveMethodOrBuiltin
  } = scratch;
  const pathLabel = (path: { name: string; isCall: boolean }[]): string =>
    path.map((s) => (s.isCall ? `${s.name}()` : s.name)).join(".");
  const edges: CallEdge[] = [];
  setCurrentFileOrigin(parsed.file.absolutePath);
  {
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
          resolved,
          column: call.column,
          endColumn: call.endColumn
        });
      };

      switch (hint.kind) {
        case "BareName": {
          // Order: project method → component method → plugin command → builtin → unresolved
          const matches = byName.get(hint.name.toLowerCase()) ?? [];
          const method = matches.find(
            (s) =>
              s.kind === SymbolKind.ProjectMethod ||
              s.kind === SymbolKind.DatabaseMethod
          );
          if (method) {
            pushEdge(method.id, CallKind.Static, true);
          } else if (input.componentByMethod?.has(hint.name)) {
            pushEdge(input.componentByMethod.get(hint.name)!, CallKind.Static, true);
          } else if (commandToPlugin.has(hint.name)) {
            pushEdge(commandToPlugin.get(hint.name)!, CallKind.Static, true);
          } else if (BUILTIN_SET.has(hint.name)) {
            pushEdge(findOrCreateBuiltin(hint.name), CallKind.Static, true);
          } else if (PLUGIN_PREFIXES.some((p) => hint.name.startsWith(p))) {
            // Plugin-like name (legacy prefix heuristic) — classify as builtin
            pushEdge(findOrCreateBuiltin(hint.name), CallKind.Static, true);
          } else {
            pushEdge(findOrCreateUnresolved(hint.name), CallKind.Dynamic, false);
          }
          break;
        }
        case "BuiltinChain": {
          if (commandToPlugin.has(hint.name)) {
            pushEdge(commandToPlugin.get(hint.name)!, CallKind.Static, true);
          } else if (BUILTIN_SET.has(hint.name)) {
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
        case "CsNewNs": {
          const nsKey = `cs.${hint.namespace}.${hint.className}`.toLowerCase();
          const cls = componentClassByNs.get(nsKey);
          if (cls) {
            // Prefer the constructor symbol if we have one — otherwise attribute the
            // call to the Class symbol so the component still surfaces a caller.
            const ctor = classFunctions.get(`cs.${hint.namespace}.${hint.className}.constructor`.toLowerCase());
            pushEdge(ctor?.id ?? cls.id, CallKind.Static, true);
          } else {
            pushEdge(findOrCreateUnresolved(`cs.${hint.namespace}.${hint.className}.new`), CallKind.Dynamic, false);
          }
          break;
        }
        case "CsCallNs": {
          const fnKey = `cs.${hint.namespace}.${hint.className}.${hint.method}`.toLowerCase();
          const fn = classFunctions.get(fnKey);
          if (fn) {
            pushEdge(fn.id, CallKind.Static, true);
          } else {
            // Fall back: attribute to the Class symbol so callers still get aggregated.
            const cls = componentClassByNs.get(`cs.${hint.namespace}.${hint.className}`.toLowerCase());
            if (cls) {
              pushEdge(cls.id, CallKind.Static, true);
            } else {
              pushEdge(findOrCreateUnresolved(`cs.${hint.namespace}.${hint.className}.${hint.method}`), CallKind.Dynamic, false);
            }
          }
          break;
        }
        case "CsGetNs": {
          const g = classGetters.get(`cs.${hint.namespace}.${hint.className}.${hint.property}`.toLowerCase());
          if (g) pushEdge(g.id, CallKind.Static, true);
          break;
        }
        case "CsSetNs": {
          const s = classSetters.get(`cs.${hint.namespace}.${hint.className}.${hint.property}`.toLowerCase());
          if (s) pushEdge(s.id, CallKind.Static, true);
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
            // Built-in DataClass method like .query, .new, .all — bucket per table.
            pushEdge(findOrCreateTableBuiltin(hint.className, hint.method), CallKind.Static, true);
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
            // Fall back to the builtin API for flavored classes:
            // `Entity.save`, `EntitySelection.query`, `DataClass.new`, etc.
            // (`resolveMethodOrBuiltin` consults classFlavor via builtinBaseOf.)
            const hit = resolveMethodOrBuiltin(className, hint.method);
            if (hit) {
              pushEdge(hit.id, CallKind.Static, true);
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
          const rawType = locals?.get(hint.variable);
          // First try the canonical chain-walker form so EntitySelection<T>,
          // Collection, etc. land on their builtin API entry.
          const canon = normalizeType(rawType);
          if (canon) {
            const hit = resolveMethodOrBuiltin(canon, hint.method);
            if (hit) {
              pushEdge(hit.id, CallKind.Static, true);
              break;
            }
          }
          // Legacy fallback: classFromVarType returns the bare class name and
          // tolerates `cs.<X>` shapes the canonical normaliser drops; preserve
          // the previous behaviour of attributing to a synthetic Builtin on miss.
          const targetClass = classFromVarType(rawType);
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
        case "ThisChainCall": {
          // Walk `This.<...>.method()` starting from the current class. Each
          // path step is either a property access or a mid-chain method call;
          // the resolver advances the "current type" accordingly.
          const fallbackLabel = `This.${pathLabel(hint.path)}.${hint.method}`;
          if (!className) {
            pushEdge(findOrCreateUnresolved(fallbackLabel), CallKind.Dynamic, false);
            break;
          }
          let currentType: string | undefined = className;
          for (const step of hint.path) {
            if (!currentType) break;
            currentType = step.isCall ? stepMethodReturn(currentType, step.name) : stepProperty(currentType, step.name);
          }
          if (currentType) {
            const hit = resolveMethodOrBuiltin(currentType, hint.method);
            if (hit) {
              pushEdge(hit.id, CallKind.Static, true);
              break;
            }
          }
          pushEdge(findOrCreateUnresolved(fallbackLabel), CallKind.Dynamic, false);
          break;
        }
        case "VarChainCall": {
          // Walk `$var.<...>.method()` where intermediate segments can be
          // either property accesses (pass 1 + 2) or method calls (pass 3).
          const fallbackLabel = `$${hint.variable}.${pathLabel(hint.path)}.${hint.method}`;
          const locals = localTypes.get(call.fromSymbolId);
          const startType = locals?.get(hint.variable);
          if (!startType) {
            pushEdge(findOrCreateUnresolved(fallbackLabel), CallKind.Dynamic, false);
            break;
          }
          let currentType: string | undefined = normalizeType(startType);
          for (const step of hint.path) {
            if (!currentType) break;
            currentType = step.isCall ? stepMethodReturn(currentType, step.name) : stepProperty(currentType, step.name);
          }
          if (currentType) {
            const hit = resolveMethodOrBuiltin(currentType, hint.method);
            if (hit) {
              pushEdge(hit.id, CallKind.Static, true);
              break;
            }
          }
          pushEdge(findOrCreateUnresolved(fallbackLabel), CallKind.Dynamic, false);
          break;
        }
        case "CsChainCall": {
          // `cs.X.new().method()[.chain…]` — `.new()` constructs an instance
          // of X, so walk any remaining steps from that instance type, then
          // resolve the terminal method (same machinery as VarChainCall).
          const fallbackLabel =
            `cs.${hint.className}.new` +
            (hint.path.length ? `.${pathLabel(hint.path)}` : "") +
            `.${hint.method}`;
          let currentType: string | undefined = hint.className;
          for (const step of hint.path) {
            if (!currentType) break;
            currentType = step.isCall
              ? stepMethodReturn(currentType, step.name)
              : stepProperty(currentType, step.name);
          }
          if (currentType) {
            const hit = resolveMethodOrBuiltin(currentType, hint.method);
            if (hit) {
              pushEdge(hit.id, CallKind.Static, true);
              break;
            }
          }
          pushEdge(findOrCreateUnresolved(fallbackLabel), CallKind.Dynamic, false);
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
          // Try a FormObjectMethod first — the method may live in the child
          // form's ObjectMethods/ (symbol name is `<childForm>.<method>`).
          const fomMatches = byName.get(`${hint.formName}.${hint.methodName}`.toLowerCase()) ?? [];
          const fom = fomMatches[0];
          if (fom) {
            pushEdge(fom.id, CallKind.Dynamic, true);
            break;
          }
          // Fall back to a regular ProjectMethod — in practice the second
          // arg is most often a global project method that 4D runs in the
          // subform's context (mirrors the CallWorker/NewProcess/
          // ExecuteMethodLiteral resolution above).
          const pmMatches = byName.get(hint.methodName.toLowerCase()) ?? [];
          const pm = pmMatches.find(
            (s) => s.kind === SymbolKind.ProjectMethod || s.kind === SymbolKind.DatabaseMethod
          );
          if (pm) pushEdge(pm.id, CallKind.Dynamic, true);
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
            break;
          }
          // An Alias attribute is read like a field — link the reference to it.
          const a = resolveAliasOnChain(className, hint.property);
          if (a) {
            pushEdge(a.id, a.ownerClass === className ? CallKind.Static : CallKind.Inherited, true);
          }
          // Otherwise drop silently: likely a plain `property`, not a computed accessor/alias.
          break;
        }
        case "ThisSet": {
          if (!className) break;
          const s = resolveSetterOnChain(className, hint.property);
          if (s) {
            pushEdge(s.id, s.ownerClass === className ? CallKind.Static : CallKind.Inherited, true);
            break;
          }
          // Aliases are writable too — `This.<alias>:=…` links to the Alias symbol.
          const a = resolveAliasOnChain(className, hint.property);
          if (a) {
            pushEdge(a.id, a.ownerClass === className ? CallKind.Static : CallKind.Inherited, true);
          }
          break;
        }
        case "VarGet": {
          const locals = localTypes.get(call.fromSymbolId);
          const rawType = locals?.get(hint.variable);
          // Resolve the variable's type to a class. `normalizeType` maps the
          // dsTable:/entitySelectionOf: shapes (from `ds.X.new()` etc.) to the
          // owning entity class — `classFromVarType` gates those behind the
          // catalog, so a dataclass-typed local would otherwise miss its
          // getters/aliases.
          const target = classFromVarType(rawType) ?? normalizeType(rawType);
          if (target) {
            const g = resolveGetterOnChain(target, hint.property);
            if (g) {
              pushEdge(g.id, CallKind.Static, true);
              break;
            }
            const a = resolveAliasOnChain(target, hint.property);
            if (a) {
              pushEdge(a.id, CallKind.Static, true);
              break;
            }
          }
          // Builtin-type properties (e.g. `$col.length` on Collection).
          const canon = normalizeType(rawType);
          if (canon) {
            const bname = builtinMethodName(canon, hint.property);
            if (bname) pushEdge(findOrCreateBuiltin(bname), CallKind.Static, true);
          }
          break;
        }
        case "VarSet": {
          const locals = localTypes.get(call.fromSymbolId);
          const rawType = locals?.get(hint.variable);
          const target = classFromVarType(rawType) ?? normalizeType(rawType);
          if (!target) break;
          const s = resolveSetterOnChain(target, hint.property);
          if (s) { pushEdge(s.id, CallKind.Static, true); break; }
          const a = resolveAliasOnChain(target, hint.property);
          if (a) pushEdge(a.id, CallKind.Static, true);
          break;
        }
        case "CsGet": {
          const g = resolveGetterOnChain(hint.className, hint.property);
          if (g) { pushEdge(g.id, CallKind.Static, true); break; }
          const a = resolveAliasOnChain(hint.className, hint.property);
          if (a) pushEdge(a.id, CallKind.Static, true);
          break;
        }
        case "CsSet": {
          const s = resolveSetterOnChain(hint.className, hint.property);
          if (s) { pushEdge(s.id, CallKind.Static, true); break; }
          const a = resolveAliasOnChain(hint.className, hint.property);
          if (a) pushEdge(a.id, CallKind.Static, true);
          break;
        }
        case "DsBracketNew": {
          // Also count this as a usage of the bracket identifier (typically
          // a table-name constant like `_Rules`) so the constant's caller
          // tree includes every ds[_X] site.
          const cid = constantsByName.get(hint.ident.toLowerCase());
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
          // No user-defined class — synthesize a per-table builtin so the
          // table's `.new()` call sites still aggregate.
          pushEdge(findOrCreateTableBuiltin(table, "new"), CallKind.Static, true);
          break;
        }
        case "DsBracketCall": {
          const cid = constantsByName.get(hint.ident.toLowerCase());
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
            pushEdge(findOrCreateTableBuiltin(table, hint.method), CallKind.Static, true);
          }
          break;
        }
        case "ConstantRef": {
          // Only emit if the bare identifier resolves to a known constant or
          // process variable. Drop silently otherwise — most identifiers in
          // method bodies are local helpers, not globals.
          const id = constantsByName.get(hint.name.toLowerCase());
          if (id) pushEdge(id, CallKind.Static, true);
          break;
        }
        case "InterprocessRef": {
          const id = interprocessByName.get(hint.name.toLowerCase());
          if (id) pushEdge(id, CallKind.Static, true);
          break;
        }
        case "FormRef": {
          const id = formsByName.get(hint.formName);
          if (id) pushEdge(id, CallKind.Static, true);
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

  // Per-file dedup: identical edges (same from/to/line/callKind) within a
  // single file collapse to one. Project-wide dedup is handled by `resolve`.
  const seen = new Set<string>();
  const uniq: CallEdge[] = [];
  for (const e of edges) {
    const key = `${e.fromId}|${e.toId}|${e.line}|${e.callKind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(e);
  }
  setCurrentFileOrigin(undefined);
  return uniq;
}

export function buildSymbolIndex(
  projectRoot: string,
  parsedFiles: ParsedFile[],
  plugins: { name: string; absolutePath: string; commands?: string[] }[],
  catalogTables: Set<string> = new Set(),
  constants: { name: string; value?: string; type?: string; theme?: string; sourceFile: string; line?: number }[] = [],
  builtinConstants: { name: string; value?: string; theme?: string; sourceFile: string }[] = [],
  variables: { name: string; scope: "process" | "interprocess"; type?: string; sourceFile: string; line: number; column?: number }[] = [],
  components: {
    name: string;
    bundlePath: string;
    zipPath?: string;
    methods: string[];
    classStoreName?: string;
    classes?: {
      name: string;
      functions: string[];
      hasConstructor: boolean;
      properties?: Record<string, { className: string; componentName: string }>;
    }[];
  }[] = []
): { index: SymbolIndex; resolverInput: ResolverInput; synthOwnersByPath: Map<string, Set<string>> } {
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

  // PluginCommand symbols — one per command in each plugin's manifest.
  // The resolver routes call edges to these instead of the bundle-level
  // Plugin symbol so each command surfaces its own caller list.
  const pluginCommandIdByName = new Map<string, string>();
  for (let i = 0; i < plugins.length; i++) {
    const p = plugins[i];
    if (!p.commands) continue;
    for (const cmd of p.commands) {
      const id = symbolIdFor(SymbolKind.PluginCommand, cmd);
      if (pluginCommandIdByName.has(cmd)) continue;
      pluginCommandIdByName.set(cmd, id);
      allSymbols.push({
        id,
        name: cmd,
        kind: SymbolKind.PluginCommand,
        location: { uri: "file://" + p.absolutePath, line: 0 },
        ownerPlugin: p.name
      });
    }
  }

  // Components (compiled .4dbase bundles). Each gets a Component bundle
  // symbol (display root) plus one ComponentMethod symbol per exposed method
  // listed in methodAttributes.json. The resolver routes call edges to the
  // ComponentMethod so individual methods own their own caller list.
  const componentSyms = components.map((c) => ({
    id: symbolIdFor(SymbolKind.Component, c.name),
    name: c.name,
    kind: SymbolKind.Component,
    location: { uri: "file://" + c.bundlePath, line: 0 }
  }));
  for (const s of componentSyms) allSymbols.push(s);
  const componentMethodIdByName = new Map<string, string>();
  for (const c of components) {
    for (const m of c.methods) {
      const id = symbolIdFor(SymbolKind.ComponentMethod, m);
      if (componentMethodIdByName.has(m)) continue;
      componentMethodIdByName.set(m, id);
      allSymbols.push({
        id,
        name: m,
        kind: SymbolKind.ComponentMethod,
        location: { uri: "file://" + c.bundlePath, line: 0 },
        ownerComponent: c.name
      });
    }
  }

  // Component class symbols (Class / ClassConstructor / ClassFunction), parsed
  // from CompiledCode/classes.json in each .4DZ. Ids include the namespace
  // (`cs.<NS>.<Class>`) so they don't collide with project classes of the
  // same name. ownerClass on functions is the full `cs.<NS>.<Class>` form so
  // the existing resolveOnClassChain lookup hits them via the namespaced key.
  //
  // Locations are `{ uri: file://<bundlePath>, line: 0 }` with NO column —
  // the .4DZ ships compiled bytecode + metadata only, so no source positions
  // are available. See componentScanner.discoverComponents() for the format
  // rationale. The `ownerComponent` field is the marker downstream features
  // (semantic tokens, rename, hover) use to detect these symbols and either
  // skip column-dependent paths or fall back to line-only behavior.
  for (const c of components) {
    if (!c.classes || c.classes.length === 0) continue;
    const ns = c.classStoreName ?? c.name;
    for (const cls of c.classes) {
      const fqClass = `cs.${ns}.${cls.name}`;
      allSymbols.push({
        id: `${SymbolKind.Class}:${fqClass}`,
        name: cls.name,
        kind: SymbolKind.Class,
        location: { uri: "file://" + c.bundlePath, line: 0 },
        ownerComponent: c.name
      });
      if (cls.hasConstructor) {
        allSymbols.push({
          id: `${SymbolKind.ClassConstructor}:${fqClass}.constructor`,
          name: "constructor",
          kind: SymbolKind.ClassConstructor,
          location: { uri: "file://" + c.bundlePath, line: 0 },
          ownerClass: fqClass,
          ownerComponent: c.name
        });
      }
      for (const fn of cls.functions) {
        allSymbols.push({
          id: `${SymbolKind.ClassFunction}:${fqClass}.${fn}`,
          name: fn,
          kind: SymbolKind.ClassFunction,
          location: { uri: "file://" + c.bundlePath, line: 0 },
          ownerClass: fqClass,
          ownerComponent: c.name
        });
      }
    }
  }

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
      // Real line of the constant's <source> in the XLF when we could locate
      // it; -1 marks "unknown" so summarize() omits a misleading :1.
      location: { uri: "file://" + c.sourceFile, line: c.line ?? -1 },
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
      location: v.column !== undefined
        ? { uri: "file://" + v.sourceFile, line: v.line, column: v.column, endColumn: v.column + v.name.length }
        : { uri: "file://" + v.sourceFile, line: v.line },
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

  // The resolver consults componentMethodIdByName AFTER project methods
  // but BEFORE plugin/builtin — bare `MyComponentMethod()` attributes to
  // the specific ComponentMethod (not the bundle).
  const componentByMethod = componentMethodIdByName;

  // Component class property → type map, keyed by `cs.<ns>.<class>` (lowercase).
  // Each value maps a property name to its declared `cs.<ns>.<class>` type.
  // Built lazily from component metadata so VarChainCall can step through
  // `$x.prop.method()` chains.
  const componentClassPropsByNs = new Map<string, Map<string, string>>();
  for (const c of components) {
    if (!c.classes || c.classes.length === 0) continue;
    const ns = c.classStoreName ?? c.name;
    // Build a lookup from `<classStoreName-or-componentDir>` → ns for cross-
    // component property types (rare but supported).
    for (const cls of c.classes) {
      if (!cls.properties) continue;
      const fqClass = `cs.${ns}.${cls.name}`.toLowerCase();
      const map = new Map<string, string>();
      for (const [propName, p] of Object.entries(cls.properties)) {
        // Default to the current component's namespace when componentName is
        // empty (the common case for intra-component property types).
        const targetNs = p.componentName ? p.componentName : ns;
        map.set(propName, `cs.${targetNs}.${p.className}`);
      }
      componentClassPropsByNs.set(fqClass, map);
    }
  }

  // Project class property/getter types harvested from each parsed class file.
  // Keyed by lowercase class name; the inner map carries property/getter -> type.
  const projectClassPropsByName = new Map<string, Map<string, string>>();
  const projectClassMethodReturnsByName = new Map<string, Map<string, string>>();
  for (const parsed of parsedFiles) {
    if (!parsed.classInfo) continue;
    const key = parsed.classInfo.name.toLowerCase();
    if (parsed.classPropertyTypes) {
      const existing = projectClassPropsByName.get(key);
      if (existing) for (const [p, t] of parsed.classPropertyTypes) existing.set(p, t);
      else projectClassPropsByName.set(key, new Map(parsed.classPropertyTypes));
    }
    if (parsed.classMethodReturnsByName) {
      const existing = projectClassMethodReturnsByName.get(key);
      if (existing) for (const [m, t] of parsed.classMethodReturnsByName) existing.set(m, t);
      else projectClassMethodReturnsByName.set(key, new Map(parsed.classMethodReturnsByName));
    }
  }

  const resolverInput: ResolverInput = {
    files: parsedFiles,
    plugins: pluginSyms.map((s, i) => ({
      name: s.name,
      symbolId: s.id,
      commands: plugins[i]?.commands
    })),
    catalogTables,
    componentByMethod,
    componentClassPropsByNs,
    projectClassPropsByName,
    projectClassMethodReturnsByName
  };
  const { edges, unresolvedSymbols, synthOwnersByPath } = resolve(resolverInput, allSymbols);

  for (const u of unresolvedSymbols) allSymbols.push(u);

  const index: SymbolIndex = {
    version: INDEX_VERSION,
    builtAt: Date.now(),
    projectRoot,
    symbols: allSymbols,
    edges,
    fileMtimes: {}
  };
  return { index, resolverInput, synthOwnersByPath };
}
