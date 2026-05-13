#!/usr/bin/env node
// Smoke test: build a full index against Symphony, print summary stats.
// Usage: node scripts/smoke-test.js [projectRoot]

const path = require("path");
const { discoverFiles, discoverPlugins, discoverCatalogTables } = require("../out/indexer/projectScanner");
const { parseFile } = require("../out/indexer/fileParser");
const { buildSymbolIndex } = require("../out/indexer/nameResolver");
const { discoverConstants } = require("../out/indexer/constantsScanner");

const projectRoot = process.argv[2] || "/Users/hunterdurbin/src/4d/symphony";
console.log(`Smoke-testing against ${projectRoot}`);

const start = Date.now();
const files = discoverFiles(projectRoot, { exclusions: ["DerivedData", "Libraries", ".git", "node_modules"] });
console.log(`Discovered ${files.length} .4dm files`);

const parsed = [];
for (let i = 0; i < files.length; i++) {
  parsed.push(parseFile(files[i], projectRoot));
  if (i > 0 && i % 1000 === 0) console.log(`  parsed ${i}/${files.length}`);
}
const plugins = discoverPlugins(projectRoot);
console.log(`Discovered ${plugins.length} plugins`);
const catalogTables = discoverCatalogTables(projectRoot);
console.log(`Discovered ${catalogTables.size} catalog tables`);
const constants = discoverConstants(projectRoot);
console.log(`Discovered ${constants.length} constants`);

const idx = buildSymbolIndex(projectRoot, parsed, plugins, catalogTables, constants);
const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\nBuilt index in ${elapsed}s`);
console.log(`  Total symbols: ${idx.symbols.length}`);
console.log(`  Total edges:   ${idx.edges.length}`);

const byKind = {};
for (const s of idx.symbols) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
console.log(`\nSymbols by kind:`);
for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(20)} ${v}`);
}

const edgeByKind = { resolved: 0, unresolved: 0 };
for (const e of idx.edges) {
  if (e.resolved) edgeByKind.resolved++;
  else edgeByKind.unresolved++;
}
console.log(`\nEdges:`);
console.log(`  resolved:   ${edgeByKind.resolved}`);
console.log(`  unresolved: ${edgeByKind.unresolved}`);

// Sanity probes against known fixtures
const OrderHydrator = idx.symbols.find((s) => s.name === "OrderHydrator" && s.kind === "Class");
const OrderHydrator_Test = idx.symbols.find((s) => s.name === "OrderHydrator_Test" && s.kind === "Class");
const fnGet = idx.symbols.find((s) => s.ownerClass === "OrderHydrator" && s.name === "getNormalizedInvoiceFromDatastore");
const fnTest = idx.symbols.find((s) => s.ownerClass === "OrderHydrator_Test" && s.name === "test_getNormalizedInvoiceFromDatastore");
console.log(`\nFixture probes:`);
console.log(`  OrderHydrator class:      ${OrderHydrator ? "FOUND" : "MISSING"}`);
console.log(`  OrderHydrator_Test class: ${OrderHydrator_Test ? "FOUND" : "MISSING"}`);
console.log(`  getNormalizedInvoiceFromDatastore: ${fnGet ? "FOUND" : "MISSING"}`);
console.log(`  test_getNormalizedInvoiceFromDatastore: ${fnTest ? "FOUND" : "MISSING"}`);

if (fnGet) {
  const inbound = idx.edges.filter((e) => e.toId === fnGet.id);
  const outbound = idx.edges.filter((e) => e.fromId === fnGet.id);
  console.log(`  getNormalizedInvoiceFromDatastore: ${inbound.length} callers, ${outbound.length} callees`);
}

// Check a couple of edge cases
const auditCardNew = idx.symbols.find((s) => s.name === "AuditCard_New" && s.kind === "ProjectMethod");
if (auditCardNew) {
  const out = idx.edges.filter((e) => e.fromId === auditCardNew.id);
  const audit_ws = out.find((e) => idx.symbols.find((s) => s.id === e.toId && s.name === "AuditCard_WS"));
  console.log(`  AuditCard_New → AuditCard_WS (CALL WORKER): ${audit_ws ? "FOUND" : "MISSING"}`);
}

// ----- Getter / Setter probes -----
console.log(`\nGetter/Setter probes:`);
const shippingCostGet = idx.symbols.find(
  (s) => s.kind === "ClassGetter" && s.ownerClass === "NormalizedOrder" && s.name === "shippingCost"
);
console.log(`  ClassGetter:NormalizedOrder.shippingCost: ${shippingCostGet ? "FOUND" : "MISSING"}`);

const splitGet = idx.symbols.find(
  (s) => s.kind === "ClassGetter" && s.ownerClass === "NormalizedOrderItem" && s.name === "splitPercentage"
);
const splitSet = idx.symbols.find(
  (s) => s.kind === "ClassSetter" && s.ownerClass === "NormalizedOrderItem" && s.name === "splitPercentage"
);
console.log(`  ClassGetter:NormalizedOrderItem.splitPercentage: ${splitGet ? "FOUND" : "MISSING"}`);
console.log(`  ClassSetter:NormalizedOrderItem.splitPercentage: ${splitSet ? "FOUND" : "MISSING"}`);

if (splitSet) {
  const callers = idx.edges.filter((e) => e.toId === splitSet.id);
  console.log(`    setter callers: ${callers.length}`);
}
if (splitGet) {
  const callers = idx.edges.filter((e) => e.toId === splitGet.id);
  console.log(`    getter callers: ${callers.length}`);
}

// Symbol count and edge growth sanity
const byKindAfter = {};
for (const s of idx.symbols) byKindAfter[s.kind] = (byKindAfter[s.kind] ?? 0) + 1;
console.log(`\nClassGetter count: ${byKindAfter.ClassGetter ?? 0}`);
console.log(`ClassSetter count: ${byKindAfter.ClassSetter ?? 0}`);
const getterEdges = idx.edges.filter((e) => {
  const t = idx.symbols.find((s) => s.id === e.toId);
  return t && (t.kind === "ClassGetter" || t.kind === "ClassSetter");
});
console.log(`Edges into getters/setters: ${getterEdges.length}`);
