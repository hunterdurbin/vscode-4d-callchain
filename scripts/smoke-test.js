#!/usr/bin/env node
// Smoke test: build a full index against Symphony, print summary stats,
// and assert a battery of regression probes that lock in past bug fixes.
// Usage: node scripts/smoke-test.js [projectRoot]
// Exit code: 0 if all probes pass, 1 if any fail.

const path = require("path");
const { discoverFiles, discoverPlugins, discoverCatalogTables } = require("../out/indexer/projectScanner");
const { parseFile } = require("../out/indexer/fileParser");
const { buildSymbolIndex } = require("../out/indexer/nameResolver");
const { discoverConstants, discoverBuiltinConstants, DEFAULT_BUILTIN_CONSTANTS_PROBES } = require("../out/indexer/constantsScanner");
const { discoverVariables } = require("../out/indexer/variableScanner");
const { discoverComponents } = require("../out/indexer/componentScanner");

const projectRoot = process.argv[2] || "/Users/hunterdurbin/src/4d/symphony";
console.log(`Smoke-testing against ${projectRoot}`);

const start = Date.now();
const files = discoverFiles(projectRoot, { exclusions: ["DerivedData", "Libraries", ".git", "node_modules"] });
console.log(`Discovered ${files.length} .4dm files`);

// Constants + variables first so the parser can resolve bare-identifier
// references against the known set inline. Mirrors indexStore's set build.
const constants = discoverConstants(projectRoot);
const builtinConstants = discoverBuiltinConstants(DEFAULT_BUILTIN_CONSTANTS_PROBES);
const variables = discoverVariables(projectRoot);
console.log(`Discovered ${constants.length} constants, ${builtinConstants.length} built-in constants, ${variables.length} variables`);
const constantsSet = new Set([
  ...constants.map((c) => c.name),
  ...builtinConstants.map((c) => c.name),
  ...variables.filter((v) => v.scope === "process").map((v) => v.name)
]);

const parsed = [];
for (let i = 0; i < files.length; i++) {
  parsed.push(parseFile(files[i], projectRoot, constantsSet));
  if (i > 0 && i % 1000 === 0) console.log(`  parsed ${i}/${files.length}`);
}
const plugins = discoverPlugins(projectRoot);
console.log(`Discovered ${plugins.length} plugins`);
const catalogTables = discoverCatalogTables(projectRoot);
console.log(`Discovered ${catalogTables.size} catalog tables`);

const components = discoverComponents(projectRoot);
console.log(`Discovered ${components.length} components (${components.reduce((n, c) => n + c.methods.length, 0)} exposed methods)`);
const idx = buildSymbolIndex(projectRoot, parsed, plugins, catalogTables, constants, builtinConstants, variables, components);
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

// ===== Regression probes =====
// Each probe records pass/fail. Final exit code = 1 if any failed.
let passed = 0;
let failed = 0;
const failures = [];
function assert(label, condition, detail) {
  const ok = !!condition;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) passed++;
  else { failed++; failures.push(label); }
}
const sym = (kind, name, ownerClass) =>
  idx.symbols.find((s) =>
    s.kind === kind && s.name === name && (ownerClass === undefined || s.ownerClass === ownerClass)
  );
const callersOf = (s) => idx.edges.filter((e) => e.toId === s.id);
const calleesOf = (s) => idx.edges.filter((e) => e.fromId === s.id);

// ----- Core fixture probes -----
console.log(`\nCore fixtures:`);
const orderHydrator = sym("Class", "OrderHydrator");
assert("OrderHydrator class exists", orderHydrator);
assert("OrderHydrator_Test class exists", sym("Class", "OrderHydrator_Test"));
const fnGet = sym("ClassFunction", "getNormalizedInvoiceFromDatastore", "OrderHydrator");
assert("OrderHydrator.getNormalizedInvoiceFromDatastore exists", fnGet);
const fnTest = sym("ClassFunction", "test_getNormalizedInvoiceFromDatastore", "OrderHydrator_Test");
assert("OrderHydrator_Test.test_getNormalizedInvoiceFromDatastore exists", fnTest);
if (fnGet) {
  const inbound = callersOf(fnGet).length;
  const outbound = calleesOf(fnGet).length;
  assert("getNormalizedInvoiceFromDatastore has ≥1 caller", inbound >= 1, `${inbound} callers`);
  assert("getNormalizedInvoiceFromDatastore has ≥3 callees", outbound >= 3, `${outbound} callees`);
}

// ----- CALL WORKER with a Choose(...) first arg -----
const auditCardNew = sym("ProjectMethod", "AuditCard_New");
if (auditCardNew) {
  const auditWS = calleesOf(auditCardNew).find((e) => {
    const t = idx.symbols.find((s) => s.id === e.toId);
    return t && t.name === "AuditCard_WS";
  });
  assert("AuditCard_New → AuditCard_WS (CALL WORKER)", !!auditWS);
}

// ----- Multi-word builtins must not produce phantom bare-name edges -----
const recordGhost = sym("Unresolved", "RECORD");
assert("RECORD is NOT an Unresolved symbol (multi-word filter)", !recordGhost);

// ----- Parenthesis-less project method calls -----
const webOrderAssign = sym("ProjectMethod", "WebOrder_Assign");
if (webOrderAssign) {
  const calleeNames = new Set(
    calleesOf(webOrderAssign)
      .map((e) => idx.symbols.find((s) => s.id === e.toId)?.name)
      .filter(Boolean)
  );
  assert(
    "WebOrder_Assign → WebOrder_Assign2 (bare-name call)",
    calleeNames.has("WebOrder_Assign2")
  );
  assert(
    "WebOrder_Assign → WebOrder_Assign3 (bare-name call)",
    calleeNames.has("WebOrder_Assign3")
  );
}

// ----- Getters / setters -----
console.log(`\nGetters / setters:`);
const shippingCostGet = sym("ClassGetter", "shippingCost", "NormalizedOrder");
assert("ClassGetter NormalizedOrder.shippingCost exists", shippingCostGet);
const splitGet = sym("ClassGetter", "splitPercentage", "NormalizedOrderItem");
const splitSet = sym("ClassSetter", "splitPercentage", "NormalizedOrderItem");
assert("ClassGetter NormalizedOrderItem.splitPercentage exists", splitGet);
assert("ClassSetter NormalizedOrderItem.splitPercentage exists", splitSet);
if (splitGet) assert("splitPercentage getter has ≥2 callers", callersOf(splitGet).length >= 2, `${callersOf(splitGet).length} callers`);
if (splitSet) assert("splitPercentage setter has ≥2 callers", callersOf(splitSet).length >= 2, `${callersOf(splitSet).length} callers`);

// ----- ds[_X] bracket access resolution -----
console.log(`\nds[_X] bracket resolution:`);
const createActiveRule = sym("ClassFunction", "_createActiveRule", "Rules_Test");
if (createActiveRule) {
  const outs = calleesOf(createActiveRule);
  const newEdge = outs.find((e) => {
    const t = idx.symbols.find((s) => s.id === e.toId);
    return t && t.name === "ds.Rules.new";
  });
  const saveEdge = outs.find((e) => {
    const t = idx.symbols.find((s) => s.id === e.toId);
    return t && t.name === "Rules.save";
  });
  assert("ds[_Rules].new() → Builtin:ds.Rules.new", !!newEdge);
  assert("$eRule.save() → Builtin:Rules.save (after ds[_Rules].new())", !!saveEdge);
}

// ----- Constants symbols + value/type -----
console.log(`\nConstants:`);
const constSamples = [
  { name: "_Rules",                  expectedType: "Text",    expectedValue: "Rules",              minCallers: 5 },
  { name: "Worker_Backend",          expectedType: "Longint", expectedValue: "1",                  minCallers: 5 },
  { name: "MODULE_INVOICES",         expectedType: "Text",    expectedValue: "Invoices",           minCallers: 50 },
  { name: "4Q_TYPE_AuditCreditCards",expectedType: "Text",    expectedValue: "audit_credit_cards", minCallers: 1 }
];
for (const probe of constSamples) {
  const c = sym("Constant", probe.name);
  if (!c) { assert(`Constant ${probe.name} exists`, false); continue; }
  assert(`Constant ${probe.name} exists`, true);
  assert(`  value = ${JSON.stringify(probe.expectedValue)}`, c.constantValue === probe.expectedValue, `got ${JSON.stringify(c.constantValue)}`);
  assert(`  type = ${probe.expectedType}`, c.constantType === probe.expectedType, `got ${c.constantType}`);
  const callers = callersOf(c).length;
  assert(`  ≥${probe.minCallers} callers (constant-ref tracking)`, callers >= probe.minCallers, `${callers} callers`);
}

// ----- Built-in constants -----
console.log(`\nBuilt-in constants:`);
const isText = sym("BuiltinConstant", "Is text");
const isReal = sym("BuiltinConstant", "Is real");
const onLoad = sym("BuiltinConstant", "On Load");
assert("BuiltinConstant 'Is text' exists", !!isText, isText ? `value=${isText.constantValue}` : undefined);
assert("BuiltinConstant 'Is real' exists", !!isReal, isReal ? `value=${isReal.constantValue}` : undefined);
assert("BuiltinConstant 'On Load' exists", !!onLoad, onLoad ? `value=${onLoad.constantValue}` : undefined);
const builtinCount = idx.symbols.filter((s) => s.kind === "BuiltinConstant").length;
assert("≥1000 built-in constants indexed", builtinCount >= 1000, `${builtinCount} indexed`);

// Multi-word built-in constant refs are tracked.
const charQuote = sym("BuiltinConstant", "Char Quote");
if (charQuote) {
  const refs = callersOf(charQuote).length;
  assert(`'Char Quote' has ≥1 caller (multi-word ref)`, refs >= 1, `${refs} callers`);
}
const onLoadRefs = onLoad ? callersOf(onLoad).length : 0;
assert("'On Load' has ≥10 callers (multi-word ref)", onLoadRefs >= 10, `${onLoadRefs} callers`);

// `[Goals]April` is classic-record field access, NOT a use of the `April`
// built-in constant. After the lookbehind fix, the April constant should
// not be polluted by these false matches.
const april = sym("BuiltinConstant", "April");
if (april) {
  const callers = callersOf(april);
  const goalsBSave = callers.find((e) => {
    const f = idx.symbols.find((s) => s.id === e.fromId);
    return f && f.name && f.name.includes("Inventory_SetGoals.bSave");
  });
  assert("`[Goals]April` field access NOT counted as April ref", !goalsBSave);
}

// ----- Process / Interprocess variables -----
console.log(`\nVariables:`);
const ipVars = idx.symbols.filter((s) => s.kind === "InterprocessVariable");
const procVars = idx.symbols.filter((s) => s.kind === "ProcessVariable");
assert("≥100 interprocess variables indexed", ipVars.length >= 100, `${ipVars.length}`);
assert("≥10 process variables indexed", procVars.length >= 10, `${procVars.length}`);
const alpAlph = idx.symbols.find((s) => s.kind === "InterprocessVariable" && s.name === "aALPAlph1");
assert("<>aALPAlph1 indexed (compiler file decl)", !!alpAlph, alpAlph ? `type=${alpAlph.variableType}` : undefined);
if (alpAlph) {
  const refs = callersOf(alpAlph).length;
  assert("<>aALPAlph1 has ≥1 caller (interprocess ref tracking)", refs >= 1, `${refs} callers`);
}
const lineItemsDesc = idx.symbols.find((s) => s.kind === "ProcessVariable" && s.name === "aLineItems_Description");
if (lineItemsDesc) {
  const refs = callersOf(lineItemsDesc).length;
  assert("aLineItems_Description has ≥1 caller (process ref tracking)", refs >= 1, `${refs} callers`);
}

// ----- Components -----
console.log(`\nComponents:`);
const componentSyms = idx.symbols.filter((s) => s.kind === "Component");
assert("≥1 Component symbol indexed", componentSyms.length >= 1, `${componentSyms.length}`);
const checkoutMethods = idx.symbols.filter(
  (s) => s.kind === "ComponentMethod" && s.ownerComponent === "Checkout"
);
const checkoutCallerCount = checkoutMethods.reduce(
  (n, m) => n + callersOf(m).length,
  0
);
assert("Checkout has ≥1 component-method caller (aggregated)", checkoutCallerCount >= 1, `${checkoutCallerCount} edges across ${checkoutMethods.length} methods`);

// ===== Summary =====
console.log(`\n${"=".repeat(40)}`);
console.log(`Probes: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`\nFailed probes:`);
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
