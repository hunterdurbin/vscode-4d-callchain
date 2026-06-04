import type { SymbolIndex } from "../../packages/core/dist";

// Builds a SymbolIndex for a fixture forcing the tree-sitter parser (the
// default in the real extension). The shared-index helper falls back to the
// regex parser when tree-sitter isn't initialized, so tests that exercise
// tree-sitter-only behavior must init the WASM grammar and build through it.
// Callers must `await initTreeSitterParser()` before calling buildTreeSitterIndex.

const treeSitter = require("../../packages/core/dist/parser/parseWithTreeSitter");
const projectScanner = require("../../packages/core/dist/indexer/projectScanner");
const fileParser = require("../../packages/core/dist/indexer/fileParser");
const nameResolver = require("../../packages/core/dist/indexer/nameResolver");
const constantsScanner = require("../../packages/core/dist/indexer/constantsScanner");
const variableScanner = require("../../packages/core/dist/indexer/variableScanner");
const componentScanner = require("../../packages/core/dist/indexer/componentScanner");

export async function initTreeSitter(): Promise<void> {
  await treeSitter.initTreeSitterParser();
}

export function isTreeSitterReady(): boolean {
  return treeSitter.isTreeSitterReady();
}

export function parseWithTreeSitter(file: any): any {
  return treeSitter.parseFileWithTreeSitter(file);
}

export function buildTreeSitterIndex(projectRoot: string): SymbolIndex {
  const files = projectScanner.discoverFiles(projectRoot, {
    exclusions: ["DerivedData", "Libraries", ".git", "node_modules"]
  });
  const constants = constantsScanner.discoverConstants(projectRoot);
  const builtinConstants = constantsScanner.discoverBuiltinConstants(
    constantsScanner.DEFAULT_BUILTIN_CONSTANTS_PROBES
  );
  const variables = variableScanner.discoverVariables(projectRoot);
  const constantsSet = new Set<string>([
    ...constants.map((c: any) => c.name.toLowerCase()),
    ...builtinConstants.map((c: any) => c.name.toLowerCase()),
    ...variables.filter((v: any) => v.scope === "process").map((v: any) => v.name.toLowerCase())
  ]);
  const parsed = files.map((file: any) => fileParser.parseFile(file, projectRoot, constantsSet));
  const plugins = projectScanner.discoverPlugins(projectRoot);
  const catalogTables = projectScanner.discoverCatalogTables(projectRoot);
  const components = componentScanner.discoverComponents(projectRoot, { bundledComponentRoots: [] });
  return nameResolver.buildSymbolIndex(
    projectRoot,
    parsed,
    plugins,
    catalogTables,
    constants,
    builtinConstants,
    variables,
    components
  ).index;
}
