// Builds the "full" standalone .vsix — the variant that ships its OWN 4D
// language/grammar/themes instead of ceding them to 4D.4d-analyzer.
//
// The lean default build (npm run package) is the source of truth: package.json
// carries no syntax contributions and hard-depends on 4D.4d-analyzer. For the
// full build we temporarily merge the syntax blocks back in (from
// build/contributes.full.json) and drop the extensionDependencies, package, then
// restore package.json verbatim. The restore runs in a finally so a vsce failure
// never leaves the working tree mutated.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const manifestPath = path.join(root, "package.json");
const fragmentPath = path.join(root, "build", "contributes.full.json");

const originalText = fs.readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(originalText);
const fragment = JSON.parse(fs.readFileSync(fragmentPath, "utf8"));

// Merge the syntax contributions back in and strip the analyzer dependency —
// the standalone build provides its own grammar and must not force-install it.
manifest.contributes = { ...fragment, ...manifest.contributes };
delete manifest.extensionDependencies;

const out = `vscode-4d-callchain-${manifest.version}-full.vsix`;

try {
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[package:full] packaging standalone build → ${out}`);
  // vsce runs the vscode:prepublish hook (esbuild) itself before packaging.
  execFileSync("vsce", ["package", "--no-dependencies", "--out", out], {
    cwd: root,
    stdio: "inherit",
  });
  console.log(`[package:full] wrote ${out}`);
} finally {
  fs.writeFileSync(manifestPath, originalText);
  console.log("[package:full] restored lean package.json");
}
