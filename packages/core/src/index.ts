// Pure 4D indexer + call graph. No editor dependencies.
// Consumed by the language server and by the VSCode extension's in-process UI.

export { Indexer, classifyChange } from "./indexer/indexStore";
export type { IndexerOptions, ChangeCategory } from "./indexer/indexStore";

export { CallGraph } from "./model/callGraph";
export {
  FUNCTION_KINDS,
  descendantClassNames,
  directSubclasses,
  descendantClasses,
  overridesForClass,
  findOverridesOfFunction,
  inheritedFunctions,
  findOverriddenFunction
} from "./model/overrides";
export {
  SymbolKind,
  ClassFlavor,
  CallKind,
  INDEX_VERSION,
  symbolIdFor
} from "./model/symbol";
export type {
  FileLocation,
  LocalUsageSite,
  SymbolRecord,
  SymbolParam,
  RawCallSite,
  CallHint,
  CallEdge,
  SymbolIndex,
  ChainStep
} from "./model/symbol";
export type { ParsedFile } from "./indexer/fileParser";

export type { Logger } from "./util/logger";
export { consoleLogger } from "./util/logger";
export { TypedEmitter } from "./util/emitter";
export type { Disposable } from "./util/emitter";

export { fuzzyMatch, parseFilterQuery } from "./util/fuzzy";
export type { ParsedQuery } from "./util/fuzzy";
export { cleanLine, stripBlockComments, recoverString } from "./util/textCleanup";
export { tokenize } from "./util/lexer";
export type { LexToken, LexTokenKind, TokenizeOptions } from "./util/lexer";
export { scanBlocks } from "./util/blockScanner";
export type { Block, BlockKind } from "./util/blockScanner";
export {
  BUILTIN_TYPE_API,
  BUILTIN_TYPE_BASES,
  PARAM_ENTITY,
  PARAM_SELECTION,
  splitBuiltin
} from "./indexer/builtinTypeApi";
export type { BuiltinReturn } from "./indexer/builtinTypeApi";
export { inferLocals, normalizeLocalType, findEnclosingFunction } from "./indexer/localInference";
export { BUILTIN_SET } from "./indexer/nameResolver";

// Experimental tree-sitter parser (TODO #13, opt-in via FOURD_PARSER=treesitter).
// `initTreeSitterParser()` must be awaited once before any parseFile() call
// when the env flag is set, otherwise the legacy regex parser is used.
export {
  initTreeSitterParser,
  parseFileWithTreeSitter,
  isTreeSitterReady,
  invalidateTreeCache
} from "./parser/parseWithTreeSitter";
