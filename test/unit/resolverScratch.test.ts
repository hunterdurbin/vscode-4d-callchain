import { beforeAll, describe, expect, it } from "vitest";
import { describeWithFixture, builtinConstantsProbesFor } from "../helpers/fixture";

// De-risking test for the persistent incremental ResolverScratch: after
// removing / re-adding a file's symbols via addSymbolToScratch /
// removeSymbolFromScratch, every lookup table must equal what a freshly
// built buildResolverScratch over the same symbol set produces. The patch
// path relies on this equivalence — its correctness argument is "the
// persistent scratch always equals the fresh scratch the old code built".

const projectScanner = require("../../packages/core/dist/indexer/projectScanner");
const fileParser = require("../../packages/core/dist/indexer/fileParser");
const nameResolver = require("../../packages/core/dist/indexer/nameResolver");
const constantsScanner = require("../../packages/core/dist/indexer/constantsScanner");
const variableScanner = require("../../packages/core/dist/indexer/variableScanner");
const componentScanner = require("../../packages/core/dist/indexer/componentScanner");

type AnyScratch = any;

/** Project the comparable (data, non-closure) part of a scratch. Empty byName
 *  buckets and absent buckets are equivalent for lookups, so normalize both
 *  to "absent". Singleton maps compare by symbol id. */
function snapshot(scratch: AnyScratch) {
  const byName: Record<string, string[]> = {};
  for (const [k, list] of scratch.byName) {
    if (list.length === 0) continue;
    byName[k] = list.map((s: any) => s.id).sort();
  }
  const ids = (m: Map<string, any>) => {
    const out: Record<string, string> = {};
    for (const [k, v] of m) out[k] = typeof v === "string" ? v : v.id;
    return out;
  };
  return {
    byName,
    classByName: ids(scratch.classByName),
    componentClassByNs: ids(scratch.componentClassByNs),
    classFunctions: ids(scratch.classFunctions),
    classGetters: ids(scratch.classGetters),
    classSetters: ids(scratch.classSetters),
    classAliases: ids(scratch.classAliases),
    classProperties: ids(scratch.classProperties),
    commandToPlugin: ids(scratch.commandToPlugin),
    constantsByName: ids(scratch.constantsByName),
    interprocessByName: ids(scratch.interprocessByName),
    formsByName: ids(scratch.formsByName)
  };
}

describeWithFixture("nameResolver — incremental scratch ≡ fresh scratch", (root) => {
  let resolverInput: any;
  let symbols: any[];

  beforeAll(() => {
    const files = projectScanner.discoverFiles(root, {
      exclusions: ["DerivedData", "Libraries", ".git", "node_modules"]
    });
    const constants = constantsScanner.discoverConstants(root);
    const builtinConstants = constantsScanner.discoverBuiltinConstants(
      builtinConstantsProbesFor(root, constantsScanner.DEFAULT_BUILTIN_CONSTANTS_PROBES)
    );
    const variables = variableScanner.discoverVariables(root);
    const constantsSet = new Set<string>([
      ...constants.map((c: any) => c.name.toLowerCase()),
      ...builtinConstants.map((c: any) => c.name.toLowerCase()),
      ...variables.filter((v: any) => v.scope === "process").map((v: any) => v.name.toLowerCase())
    ]);
    const parsed = files.map((f: any) => fileParser.parseFile(f, root, constantsSet));
    const plugins = projectScanner.discoverPlugins(root);
    const catalogTables = projectScanner.discoverCatalogTables(root);
    const components = componentScanner.discoverComponents(root, { bundledComponentRoots: [] });
    const built = nameResolver.buildSymbolIndex(
      root, parsed, plugins, catalogTables, constants, builtinConstants, variables, components
    );
    resolverInput = built.resolverInput;
    symbols = built.index.symbols;
  });

  /** Pick the file (by location uri) owning the most symbols of a given kind filter. */
  function symbolsOfFileContaining(predicate: (s: any) => boolean): any[] {
    const target = symbols.find(predicate);
    expect(target, "fixture must contain a matching symbol").toBeTruthy();
    const uri = target.location.uri;
    return symbols.filter((s) => s.location.uri === uri && uri !== "");
  }

  function roundTrip(fileSymbols: any[]) {
    const fileIds = new Set(fileSymbols.map((s) => s.id));

    const live = nameResolver.buildResolverScratch(resolverInput, symbols);

    // Remove the file's symbols incrementally; compare against a fresh build
    // over the remaining set.
    for (const s of fileSymbols) nameResolver.removeSymbolFromScratch(live, s);
    const without = symbols.filter((s) => !fileIds.has(s.id));
    expect(snapshot(live)).toEqual(snapshot(nameResolver.buildResolverScratch(resolverInput, without)));

    // Add them back; must equal the original fresh build again.
    for (const s of fileSymbols) nameResolver.addSymbolToScratch(live, s);
    expect(snapshot(live)).toEqual(snapshot(nameResolver.buildResolverScratch(resolverInput, symbols)));
  }

  it("round-trips a class file (functions, getters/setters, properties)", () => {
    roundTrip(symbolsOfFileContaining((s) => s.kind === "ClassFunction" && s.ownerClass));
  });

  it("round-trips a project-method file", () => {
    roundTrip(symbolsOfFileContaining((s) => s.kind === "ProjectMethod"));
  });

  it("round-trips a class that extends another (chain metadata intact)", () => {
    roundTrip(symbolsOfFileContaining((s) => s.kind === "Class" && s.extendsClass));
  });

  it("resetSession clears synth state but keeps lookup tables", () => {
    const live = nameResolver.buildResolverScratch(resolverInput, symbols);
    const before = snapshot(live);
    live.setCurrentFileOrigin("/tmp/x.4dm");
    live.findOrCreateBuiltin("ALERT");
    live.findOrCreateUnresolved("NoSuchMethod");
    expect(live.unresolved.length).toBe(2);
    expect(live.synthOwnersByPath.size).toBe(1);
    live.resetSession();
    expect(live.unresolved.length).toBe(0);
    expect(live.unresolvedSeen.size).toBe(0);
    expect(live.synthOwnersByPath.size).toBe(0);
    expect(snapshot(live)).toEqual(before);
    // A re-created synth after reset gets a fresh record (the patcher merges
    // it against the graph by id, same as the old fresh-scratch-per-patch).
    live.setCurrentFileOrigin("/tmp/y.4dm");
    const id = live.findOrCreateBuiltin("ALERT");
    expect(id).toBe("Builtin:ALERT");
    expect(live.unresolved.length).toBe(1);
  });
});
