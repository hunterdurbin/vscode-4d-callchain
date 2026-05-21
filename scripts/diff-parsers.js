/**
 * Diff harness — runs both parsers (regex + tree-sitter) on every .4dm file
 * under a target project and reports per-file symbol/edge deltas.
 *
 * Usage: node scripts/diff-parsers.js <path-to-4d-project>
 * Defaults to test/fixtures/mini-4d/.
 */
"use strict";

const path = require("path");
const fs = require("fs");

async function main() {
  const target =
    process.argv[2] || path.resolve(__dirname, "..", "test/fixtures/mini-4d");
  console.log("Diff harness against:", target);

  const {
    parseFileWithTreeSitter,
    initTreeSitterParser,
  } = require("../packages/core/dist/parser/parseWithTreeSitter");
  const { parseFile } = require("../packages/core/dist/indexer/fileParser");

  await initTreeSitterParser();

  const files = collectDotFourDM(path.join(target, "Project", "Sources"));
  console.log(`Found ${files.length} .4dm files\n`);

  let totalSymsRegex = 0;
  let totalSymsTs = 0;
  let totalCallsRegex = 0;
  let totalCallsTs = 0;
  let mismatches = 0;

  for (const file of files) {
    const discovered = discoveredFor(target, file);
    let regex, ts;
    try {
      regex = parseFile(discovered, new Set(), new Map());
    } catch (e) {
      console.log(`  regex parser FAILED on ${discovered.relativePath}:`, e.message);
      continue;
    }
    try {
      ts = parseFileWithTreeSitter(discovered, new Set());
    } catch (e) {
      console.log(`  treesitter parser FAILED on ${discovered.relativePath}:`, e.message);
      continue;
    }
    totalSymsRegex += regex.symbols.length;
    totalSymsTs += ts.symbols.length;
    totalCallsRegex += regex.rawCalls.length;
    totalCallsTs += ts.rawCalls.length;
    if (
      regex.symbols.length !== ts.symbols.length ||
      regex.rawCalls.length !== ts.rawCalls.length
    ) {
      mismatches++;
      console.log(
        `  ${discovered.relativePath}: regex=${regex.symbols.length}s/${regex.rawCalls.length}c  ts=${ts.symbols.length}s/${ts.rawCalls.length}c`
      );
    }
  }

  console.log("\n--- Summary ---");
  console.log(`Files: ${files.length}`);
  console.log(`Mismatched files: ${mismatches}`);
  console.log(`Symbols regex: ${totalSymsRegex}  tree-sitter: ${totalSymsTs}`);
  console.log(
    `Calls   regex: ${totalCallsRegex}  tree-sitter: ${totalCallsTs}`
  );
}

function collectDotFourDM(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectDotFourDM(p));
    else if (entry.name.endsWith(".4dm")) out.push(p);
  }
  return out;
}

function discoveredFor(projectRoot, absolutePath) {
  // Minimal DiscoveredFile shape — enough for both parsers.
  const relativePath = path.relative(projectRoot, absolutePath);
  const base = path.basename(absolutePath, ".4dm");
  let category;
  if (relativePath.includes("/Classes/")) category = "class";
  else if (base.startsWith("Compiler_")) category = "compilerMethod";
  else if (relativePath.includes("/Forms/")) category = "formMethod";
  else if (relativePath.includes("/Methods/")) category = "method";
  else category = "method";
  return { absolutePath, relativePath, category };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
