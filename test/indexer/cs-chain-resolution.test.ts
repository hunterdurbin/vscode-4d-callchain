import { beforeAll, expect, it } from "vitest";
import * as path from "path";
import { describeWithFixture } from "../helpers/fixture";
import type { SymbolIndex } from "../../packages/core/dist";

// Exercises the tree-sitter parser specifically (the default in the real
// extension), so it must init the WASM grammar and build the index through
// it — unlike the shared-index helper, which falls back to the regex parser
// when tree-sitter isn't ready. Locks in the `cs.X.new().method()` single-
// line chain fix: the method invoked on the freshly-constructed instance
// must emit a resolved CsChainCall edge (previously skipped entirely).

const treeSitter = require("../../packages/core/dist/parser/parseWithTreeSitter");
const projectScanner = require("../../packages/core/dist/indexer/projectScanner");
const fileParser = require("../../packages/core/dist/indexer/fileParser");
const nameResolver = require("../../packages/core/dist/indexer/nameResolver");
const constantsScanner = require("../../packages/core/dist/indexer/constantsScanner");
const variableScanner = require("../../packages/core/dist/indexer/variableScanner");
const componentScanner = require("../../packages/core/dist/indexer/componentScanner");

const MINI_FIXTURE_BASENAME = "mini-4d";

function buildTreeSitterIndex(projectRoot: string): SymbolIndex {
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

describeWithFixture("indexer/cs-chain-resolution — cs.X.new().method() chains", (root) => {
  const isMini = root.endsWith(MINI_FIXTURE_BASENAME);
  let idx: SymbolIndex;

  beforeAll(async () => {
    if (!isMini) return;
    await treeSitter.initTreeSitterParser();
    expect(treeSitter.isTreeSitterReady()).toBe(true);
    idx = buildTreeSitterIndex(root);
  });

  it("emits a CsChainCall hint for a single-line cs.X.new().method() chain", () => {
    if (!isMini) return;
    const absolutePath = path.join(
      root,
      "Project",
      "Sources",
      "Classes",
      "OrderHydrator_Test.4dm"
    );
    const parsed = treeSitter.parseFileWithTreeSitter({
      absolutePath,
      relativePath: "Project/Sources/Classes/OrderHydrator_Test.4dm",
      category: "class"
    });
    const hint = parsed.rawCalls
      .map((c: any) => c.hint)
      .find((h: any) => h && h.kind === "CsChainCall");
    expect(hint).toBeTruthy();
    expect(hint.className).toBe("OrderHydrator");
    expect(hint.method).toBe("getNormalizedInvoiceFromDatastore");
  });

  it("resolves the chained method to OrderHydrator.getNormalizedInvoiceFromDatastore", () => {
    if (!isMini) return;
    const from = idx.symbols.find(
      (s: any) =>
        s.kind === "ClassFunction" &&
        s.name === "test_chainedNew" &&
        s.ownerClass === "OrderHydrator_Test"
    );
    expect(from).toBeTruthy();
    if (!from) return;
    const callee = idx.edges
      .filter((e) => e.fromId === from.id)
      .find((e) => idx.symbols.find((s) => s.id === e.toId)?.name === "getNormalizedInvoiceFromDatastore");
    expect(callee).toBeTruthy();
    expect(callee?.resolved).toBe(true);
  });
});
