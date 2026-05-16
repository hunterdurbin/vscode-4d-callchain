import type { SymbolIndex } from "../../packages/core/dist";

const projectScanner = require("../../packages/core/dist/indexer/projectScanner");
const fileParser = require("../../packages/core/dist/indexer/fileParser");
const nameResolver = require("../../packages/core/dist/indexer/nameResolver");
const constantsScanner = require("../../packages/core/dist/indexer/constantsScanner");
const variableScanner = require("../../packages/core/dist/indexer/variableScanner");
const componentScanner = require("../../packages/core/dist/indexer/componentScanner");

const cache = new Map<string, Promise<SymbolIndex>>();

export function getSharedIndex(projectRoot: string): Promise<SymbolIndex> {
  const existing = cache.get(projectRoot);
  if (existing) return existing;
  const promise = buildIndex(projectRoot);
  cache.set(projectRoot, promise);
  return promise;
}

async function buildIndex(projectRoot: string): Promise<SymbolIndex> {
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
    ...variables
      .filter((v: any) => v.scope === "process")
      .map((v: any) => v.name.toLowerCase())
  ]);

  const parsed = files.map((file: any) => fileParser.parseFile(file, projectRoot, constantsSet));
  const plugins = projectScanner.discoverPlugins(projectRoot);
  const catalogTables = projectScanner.discoverCatalogTables(projectRoot);
  const components = componentScanner.discoverComponents(projectRoot);

  return nameResolver.buildSymbolIndex(
    projectRoot,
    parsed,
    plugins,
    catalogTables,
    constants,
    builtinConstants,
    variables,
    components
  );
}

export function symFinder(idx: SymbolIndex) {
  return (kind: string, name: string, ownerClass?: string) =>
    idx.symbols.find(
      (s) =>
        s.kind === (kind as any) &&
        s.name === name &&
        (ownerClass === undefined || (s as any).ownerClass === ownerClass)
    );
}

export function callersOf(idx: SymbolIndex, sym: { id: string } | undefined) {
  if (!sym) return [];
  return idx.edges.filter((e) => e.toId === sym.id);
}

export function calleesOf(idx: SymbolIndex, sym: { id: string } | undefined) {
  if (!sym) return [];
  return idx.edges.filter((e) => e.fromId === sym.id);
}
