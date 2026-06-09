export enum SymbolKind {
  ProjectMethod = "ProjectMethod",
  CompilerMethod = "CompilerMethod",
  Class = "Class",
  ClassFunction = "ClassFunction",
  ClassConstructor = "ClassConstructor",
  ClassGetter = "ClassGetter",
  ClassSetter = "ClassSetter",
  Form = "Form",
  FormMethod = "FormMethod",
  FormObjectMethod = "FormObjectMethod",
  TableForm = "TableForm",
  TableFormMethod = "TableFormMethod",
  TableObjectMethod = "TableObjectMethod",
  DatabaseMethod = "DatabaseMethod",
  Plugin = "Plugin",
  PluginCommand = "PluginCommand",
  Component = "Component",
  ComponentMethod = "ComponentMethod",
  Builtin = "Builtin",
  TableBuiltin = "TableBuiltin",
  Constant = "Constant",
  BuiltinConstant = "BuiltinConstant",
  ProcessVariable = "ProcessVariable",
  InterprocessVariable = "InterprocessVariable",
  /** ORDA computed/alias attribute declared with `Alias <name> <targetPath>`. */
  Alias = "Alias",
  Unresolved = "Unresolved"
}

export enum ClassFlavor {
  Entity = "Entity",
  EntitySelection = "EntitySelection",
  DataClass = "DataClass",
  DataStore = "DataStore",
  Generic = "Generic",
  Interface = "Interface",
  Test = "Test"
}

export enum CallKind {
  Static = "Static",
  Dynamic = "Dynamic",
  Inherited = "Inherited",
  Formula = "Formula"
}

export interface FileLocation {
  uri: string;
  /** Zero-based line of the symbol's identifier (or 0 for file-level symbols). */
  line: number;
  /** Zero-based column of the identifier's first character. */
  column?: number;
  /** Zero-based line where the symbol's range ends. */
  endLine?: number;
  /** Zero-based column where the identifier ends (exclusive). When set with
   *  column, gives a precise word-level range for hover / go-to-def. */
  endColumn?: number;
}

export interface SymbolRecord {
  id: string;
  name: string;
  kind: SymbolKind;
  location: FileLocation;
  ownerClass?: string;
  classFlavor?: ClassFlavor;
  extendsClass?: string;
  /**
   * Role of a class member. `get`/`set` are computed-attribute accessors;
   * `query`/`orderBy` are the optimized-query / sort backers for a computed
   * attribute (declared `Function query <attr>` / `Function orderBy <attr>`);
   * `function` is a plain method. For `query`/`orderBy`, `computedFor` names
   * the attribute they back so get_symbol can disambiguate them from the
   * same-named getter by role.
   */
  accessor?: "get" | "set" | "function" | "query" | "orderBy";
  /** For `query`/`orderBy` backers: the computed attribute name they implement. */
  computedFor?: string;
  /** For Alias symbols: the target attribute path, e.g. `invoice.InvoiceID`. */
  aliasTarget?: string;
  scope?: "local" | "shared" | "public";
  returnType?: string;
  /** For Constant symbols: the parsed value, e.g. "Rules" or "3". */
  constantValue?: string;
  /** For Constant symbols: friendly type name e.g. "Text", "Longint". */
  constantType?: string;
  /** For Constant symbols: 4D theme/group name if known. */
  constantTheme?: string;
  /** For ProcessVariable / InterprocessVariable symbols: friendly type label. */
  variableType?: string;
  /** For PluginCommand symbols: name of the Plugin bundle the command belongs to. */
  ownerPlugin?: string;
  /** For ComponentMethod symbols: name of the Component bundle the method belongs to. */
  ownerComponent?: string;
  /** For TableForm / TableFormMethod / TableObjectMethod: name of the parent table (disambiguates same-named forms across tables). */
  ownerTable?: string;
  /** For function / method / constructor symbols: declared parameters in source order. */
  params?: SymbolParam[];
  /**
   * Reference-count of source files that contributed this synthetic symbol
   * (Builtin / TableBuiltin / Unresolved). Each entry is an absolute file path
   * that produced an edge targeting this symbol. Only populated on synthetic
   * symbols whose `location.uri` is `""`. Incremental indexing decrements on
   * file change/delete and removes the synth when the count reaches zero.
   */
  fileOrigins?: string[];
  /**
   * Source span of the symbol's body (declaration through closing keyword).
   * Populated for ProjectMethod / FormMethod / ClassFunction /
   * ClassConstructor / ClassGetter / ClassSetter — the kinds the linter
   * scans for variable usage and leading docstrings. Both lines are
   * zero-based and inclusive. Only set by the tree-sitter parser; the
   * regex fallback leaves it undefined.
   */
  bodySpan?: { startLine: number; endLine: number };
}

/**
 * One occurrence of a local variable inside a symbol's body — either a read
 * or a write. Carries enough position info for the linter to emit precise
 * diagnostic ranges. Tracked per `ParsedFile.localReads` / `localWrites`.
 */
export interface LocalUsageSite {
  line: number;
  column: number;
  endColumn: number;
}

export interface SymbolParam {
  name: string;
  type?: string;
  /**
   * Marks a "rest" parameter — the method accepts zero-or-more additional
   * arguments of `type` after this position. Only set on the LAST entry in
   * a `params[]` array. Used to model 4D's `${N}` notation found in
   * `Compiler_*.4dm` files (e.g. `C_LONGINT(Math_Minimum; ${1})` means
   * "any number of LONGINT args from $1 onward").
   *
   * 4D's `#DECLARE` syntax doesn't currently express variadic params —
   * methods that take a variable number of args rely on the Compiler_*
   * declaration alone. See TODO #24.
   */
  variadic?: boolean;
}

export interface RawCallSite {
  fromSymbolId: string;
  line: number;
  raw: string;
  expression: string;
  hint?: CallHint;
  /** Zero-based column of the callee identifier (start). Optional. */
  column?: number;
  /** Zero-based column of the callee identifier (exclusive end). */
  endColumn?: number;
}

export type CallHint =
  | { kind: "BareName"; name: string }
  | { kind: "CsNew"; className: string }
  | { kind: "CsCall"; className: string; method: string }
  | { kind: "CsNewNs"; namespace: string; className: string }
  | { kind: "CsCallNs"; namespace: string; className: string; method: string }
  | { kind: "CsGetNs"; namespace: string; className: string; property: string }
  | { kind: "CsSetNs"; namespace: string; className: string; property: string }
  | { kind: "DsCall"; className: string; method: string }
  | { kind: "DsAccess"; className: string }
  | { kind: "ThisCall"; method: string }
  | { kind: "SuperCall"; method?: string }
  | { kind: "VarCall"; variable: string; method: string }
  | { kind: "VarChainCall"; variable: string; path: ChainStep[]; method: string }
  | { kind: "ThisChainCall"; path: ChainStep[]; method: string }
  | { kind: "CsChainCall"; className: string; path: ChainStep[]; method: string }
  | { kind: "ThisGet"; property: string }
  | { kind: "ThisSet"; property: string }
  | { kind: "VarGet"; variable: string; property: string }
  | { kind: "VarSet"; variable: string; property: string }
  | { kind: "CsGet"; className: string; property: string }
  | { kind: "CsSet"; className: string; property: string }
  | { kind: "DsBracketNew"; ident: string }
  | { kind: "DsBracketCall"; ident: string; method: string }
  | { kind: "ConstantRef"; name: string }
  | { kind: "InterprocessRef"; name: string }
  | { kind: "ProjectMethodBare"; name: string }
  | { kind: "FormRef"; formName: string }
  | { kind: "CallWorker"; methodName: string }
  | { kind: "NewProcess"; methodName: string }
  | { kind: "ExecuteMethodLiteral"; methodName: string }
  | { kind: "ExecuteMethodDynamic"; variable: string }
  | { kind: "ExecuteMethodInSubform"; formName: string; methodName: string }
  | { kind: "Formula"; body: string }
  | { kind: "BuiltinChain"; name: string };

export interface CallEdge {
  fromId: string;
  toId: string;
  callKind: CallKind;
  line: number;
  raw: string;
  resolved: boolean;
  /** Zero-based column of the callee identifier on `line`, when known. */
  column?: number;
  /** Zero-based exclusive end column of the callee identifier. */
  endColumn?: number;
}

export interface SymbolIndex {
  version: number;
  builtAt: number;
  projectRoot: string;
  symbols: SymbolRecord[];
  edges: CallEdge[];
  fileMtimes: Record<string, number>;
  /** mtime of `Project/Sources/catalog.4DCatalog`, used by isFresh() to detect
   *  offline edits to the catalog while VS Code was closed. */
  catalogMtime?: number;
  /** mtimes for every `Resources/Constants_*.xlf` file the indexer discovered. */
  constantsMtimes?: Record<string, number>;
  /** mtimes for every component `.4DZ` archive the indexer discovered. */
  componentMtimes?: Record<string, number>;
}

/**
 * One step inside a chained expression like `$x.foo().bar.baz()`. Properties
 * are `{ name, isCall: false }`; method calls are `{ name, isCall: true }`.
 * The resolver uses isCall to decide whether to look up a return type or a
 * property type when walking the chain.
 */
export interface ChainStep {
  name: string;
  isCall: boolean;
}

// Bumped to 30 when the tree-sitter parser became the default (TODO #13).
// Bumped to 31 after fixing flattenChain's call-flag annotation (`cs.X.new()
// .method()` chains were emitting bogus `CsCallNs` edges; ~3k spurious
// `Cannot resolve` diagnostics per Symphony project).
// Bumped to 32 when variadic params from Compiler_*.4dm started landing
// on `SymbolRecord.params[]`.
// Bumped to 33 when discoverComponents() started picking up 4D-bundled
// components (NetKit, Widgets, ViewPro, …) from the 4D app bundle, and
// when ExecuteMethodInSubform gained a ProjectMethod fallback.
// Bumped to 34 when cleanLine + the tree-sitter grammar started treating
// the backtick (`) as a single-line comment marker (4D v18+) — cached
// edges previously emitted from inside backtick comments must be flushed.
// Bumped to 35 when ParsedFile gained localReads / localWrites /
// localDeclMode + SymbolRecord gained bodySpan to support the linter
// (Phase A). Cached indexes still load fine without these (they're
// optional), but a rebuild ensures the new fields populate.
// Bumped to 36 when `cs.X.new().method()` single-line chains started
// emitting a resolved CsChainCall edge (previously the parser skipped the
// trailing method on any cs chain containing an intermediate call).
// Bumped to 37 when the incremental patch path started deduping edges on
// append (`appendEdgeDeduped`). Caches built by the old patch path could
// contain doubled call edges (same from/to/line/callKind/column) when a
// file's add ran without a preceding remove; the bump flushes those.
// Bumped to 38 when user constants gained a real `<source>` line in their
// XLF (was a stub line 0 → bogus :1). Unknown lines use a -1 sentinel that
// summarize() omits.
// Bumped to 39 when `Function query` / `Function orderBy` computed-attribute
// backers became first-class symbols (previously unindexed — their bodies
// bled into the preceding function), tagged with accessor + computedFor, and
// `Alias <name> <target>` attributes gained their own SymbolKind.Alias symbol.
// Cached indexes built before each bump are silently invalidated on load —
// users see one rebuild after upgrading.
export const INDEX_VERSION = 39;

export function symbolIdFor(kind: SymbolKind, name: string, ownerClass?: string): string {
  if (ownerClass) {
    return `${kind}:${ownerClass}.${name}`;
  }
  return `${kind}:${name}`;
}
