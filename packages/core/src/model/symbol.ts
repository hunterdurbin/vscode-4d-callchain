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
  line: number;
  column?: number;
  endLine?: number;
}

export interface SymbolRecord {
  id: string;
  name: string;
  kind: SymbolKind;
  location: FileLocation;
  ownerClass?: string;
  classFlavor?: ClassFlavor;
  extendsClass?: string;
  accessor?: "get" | "set" | "function";
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
}

export interface RawCallSite {
  fromSymbolId: string;
  line: number;
  raw: string;
  expression: string;
  hint?: CallHint;
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
}

export interface SymbolIndex {
  version: number;
  builtAt: number;
  projectRoot: string;
  symbols: SymbolRecord[];
  edges: CallEdge[];
  fileMtimes: Record<string, number>;
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

export const INDEX_VERSION = 23;

export function symbolIdFor(kind: SymbolKind, name: string, ownerClass?: string): string {
  if (ownerClass) {
    return `${kind}:${ownerClass}.${name}`;
  }
  return `${kind}:${name}`;
}
