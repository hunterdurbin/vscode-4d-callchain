#!/usr/bin/env node
// Generates packages/core/src/model/builtins.json from the 4d-v21 skill docs.
// Usage: node scripts/build-builtins.js [path-to-skill-root]
// Default: ./4d-v21-skill (override with the [path-to-skill-root] argument)

const fs = require("fs");
const path = require("path");

const skillRoot = process.argv[2] || "./4d-v21-skill";
const docsRoot = path.join(skillRoot, "docs");

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(p);
  }
  return out;
}

function extractTitle(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  // YAML frontmatter: --- ... title: Foo ... ---
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const titleMatch = fm[1].match(/^title:\s*"?(.+?)"?\s*$/m);
    if (titleMatch) return titleMatch[1].trim();
  }
  // Fallback: first H1
  const h1 = content.match(/^#\s+(.+?)\s*$/m);
  if (h1) return h1[1].trim();
  // Last resort: filename
  return path.basename(filePath, ".md");
}

const sources = [
  { dir: path.join(docsRoot, "commands"), kind: "command" },
  { dir: path.join(docsRoot, "commands-legacy"), kind: "legacy-command" }
];

const builtins = new Set();
const objectMethodPrefixes = new Set(); // e.g. for class-like accessors

for (const src of sources) {
  const files = walk(src.dir);
  for (const f of files) {
    // Skip theme overviews
    if (f.includes("/theme/")) continue;
    const title = extractTitle(f);
    if (!title) continue;
    // Tokenize multi-word commands but keep originals — 4D allows spaces in commands
    builtins.add(title);
  }
}

// Add a stop-word list of structural keywords (case-insensitive, no `(...)` calls)
const keywords = [
  "If", "Else", "End if", "For", "End for", "For each", "End for each",
  "While", "End while", "Repeat", "Until", "Case of", "End case",
  "Begin SQL", "End SQL", "Use", "End use", "Function", "End",
  "Class", "Class constructor", "var", "property", "local",
  "return", "Return", "throw", "Throw", "Try", "Catch", "End try",
  "True", "False", "Null", "This", "Super", "self", "ds", "cs",
  "Form event code", "On Load", "On Unload", "On Clicked", "On Validate",
  "#DECLARE", "ARRAY TEXT",
  "CREATE RECORD", "SAVE RECORD", "DELETE RECORD", "QUERY", "ORDER BY",
  "READ ONLY", "READ WRITE", "UNLOAD RECORD", "LOAD RECORD"
];
for (const k of keywords) builtins.add(k);

// Common plugin prefix detection — these will not be project methods
const pluginCommandPrefixes = [
  "HTTP ", "WP ", "ZIP_", "JSON ", "XML ", "Web ", "FTP_",
  "PG_", "SQL_", "Mail_", "Bin_", "Crypto_", "JWT_",
  "ALP_", "NTK_", "Notification_"
];

const output = {
  generatedAt: new Date().toISOString(),
  source: "4d-v21 builtins skill",
  count: builtins.size,
  commands: Array.from(builtins).sort(),
  pluginCommandPrefixes
};

const outPath = path.join(__dirname, "..", "packages", "core", "src", "model", "builtins.json");
fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`Wrote ${output.count} built-in commands to ${outPath}`);
