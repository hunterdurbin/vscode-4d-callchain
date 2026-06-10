#!/usr/bin/env node
// Bump the published extension version, keeping every file that records it in
// sync. The marketplace VSIX is built from packages/vscode-client/package.json,
// so that file is the source of truth — but the root package.json and the
// package-lock.json entries must move with it (a past release shipped a stale
// VSIX because only the root was bumped).
//
// Usage: node scripts/bump-version.mjs [major|minor|patch]   (default: patch)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const part = (process.argv[2] || 'patch').toLowerCase();
if (!['major', 'minor', 'patch'].includes(part)) {
  console.error(`Unknown bump part "${part}" — expected major, minor, or patch.`);
  process.exit(1);
}

const EXT_PKG = join(ROOT, 'packages/vscode-client/package.json');
const current = JSON.parse(readFileSync(EXT_PKG, 'utf8')).version;
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
if (!m) {
  console.error(`Cannot parse current version "${current}" as MAJOR.MINOR.PATCH.`);
  process.exit(1);
}
let [major, minor, patch] = m.slice(1).map(Number);
if (part === 'major') { major++; minor = 0; patch = 0; }
else if (part === 'minor') { minor++; patch = 0; }
else { patch++; }
const next = `${major}.${minor}.${patch}`;

// Rewrite the literal "version" line so we preserve each file's exact
// formatting (indentation, key order, trailing newline) instead of round-trips.
function setVersion(relPath, from, to, occurrences) {
  const file = join(ROOT, relPath);
  const before = readFileSync(file, 'utf8');
  const needle = `"version": "${from}"`;
  const found = before.split(needle).length - 1;
  if (found !== occurrences) {
    console.error(`${relPath}: expected ${occurrences} "${from}" version field(s), found ${found}. Aborting.`);
    process.exit(1);
  }
  writeFileSync(file, before.split(needle).join(`"version": "${to}"`));
}

// Root + extension manifest each carry the version once.
setVersion('package.json', current, next, 1);
setVersion('packages/vscode-client/package.json', current, next, 1);
// package-lock.json records it three times: top-level, the "" root workspace,
// and the packages/vscode-client workspace entry.
setVersion('package-lock.json', current, next, 3);

console.log(`Bumped ${part}: ${current} -> ${next}`);
console.log(`Next: review changes, then  git commit -am "Bump version to ${next}"  and tag  v${next}`);
