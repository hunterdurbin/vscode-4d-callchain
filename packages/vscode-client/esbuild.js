// Bundles the extension into a single dist/extension.js for packaging into a
// .vsix, plus the MCP server into dist/mcp/bin.js, and copies the two
// tree-sitter wasm assets next to the extension bundle.
//
// Why bundle: the @4d/* packages are npm-workspace symlinks and web-tree-sitter
// ships a runtime wasm — a plain `vsce package` would miss them and produce a
// broken .vsix. esbuild inlines all the pure-JS deps (including @4d/core and
// web-tree-sitter's loader), and we copy the wasm blobs the loader needs.
//
// Output is deliberately NOT minified: the .vsix ships readable JS so that
// marketplace reviewers (and anyone auditing the package) can diff it against
// this repo. Size cost is modest and worth it.
//
// Kept external (NOT bundled):
//   - vscode: provided by the host at runtime.
//   - @4d/parser-4d: only used for its wasmPath, which we supply directly from
//     the copied tree-sitter-fourd.wasm; its require is lazy and never executed
//     in either bundle (see @4d/core initTreeSitterParser — both the extension
//     and the MCP server pass explicit wasm paths from dist/).
//   - @4d/language-server: spawned only behind an opt-in config flag that
//     defaults off and is intentionally not shipped in the lean
//     Call-Chain-only .vsix.

const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const outdir = path.join(__dirname, "dist");

function resolvePkgFile(spec) {
  // Resolve a file that lives inside an installed package, following the
  // workspace's hoisted node_modules.
  return require.resolve(spec, { paths: [__dirname] });
}

function copyWasmAssets() {
  fs.mkdirSync(outdir, { recursive: true });

  // web-tree-sitter runtime wasm.
  const runtimeWasm = resolvePkgFile("web-tree-sitter/tree-sitter.wasm");
  fs.copyFileSync(runtimeWasm, path.join(outdir, "tree-sitter.wasm"));

  // @4d/parser-4d grammar wasm. The package's main entry exports `wasmPath`;
  // resolve via the package dir so we don't depend on its internal layout.
  const parserPkgJson = resolvePkgFile("@4d/parser-4d/package.json");
  const grammarWasm = path.join(path.dirname(parserPkgJson), "tree-sitter-fourd.wasm");
  fs.copyFileSync(grammarWasm, path.join(outdir, "tree-sitter-fourd.wasm"));

  console.log("[esbuild] copied tree-sitter.wasm + tree-sitter-fourd.wasm → dist/");
}

function copyWebviewAssets() {
  // Webview panels load their js/css at runtime from disk — those files are
  // not part of the esbuild bundle, and .vscodeignore excludes src/** and
  // node_modules/**, so they must live in dist/ to survive `vsce package`.
  const views = [
    { src: path.join(__dirname, "src", "views", "traceView", "webview"), out: path.join(outdir, "webview", "trace") },
  ];
  for (const { src, out } of views) {
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(out, { recursive: true });
    for (const f of fs.readdirSync(src)) {
      fs.copyFileSync(path.join(src, f), path.join(out, f));
    }
  }

  console.log("[esbuild] copied webview assets → dist/webview/");
}

async function main() {
  const watch = process.argv.includes("--watch");
  // Start from a clean dist so stray tsc output from `npm run compile` never
  // rides along in the .vsix.
  fs.rmSync(outdir, { recursive: true, force: true });
  const ctx = await esbuild.context({
    entryPoints: [path.join(__dirname, "src", "extension.ts")],
    outfile: path.join(outdir, "extension.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    sourcemap: true,
    minify: false,
    external: [
      "vscode",
      "@4d/parser-4d",
      "@4d/language-server",
      "@4d/mcp-server",
    ],
    logLevel: "info",
  });

  // Standalone MCP server bundle, shipped in the .vsix so the extension's
  // MCP provider (and the copy-config command) can point at it. Launched by
  // MCP clients as `node dist/mcp/bin.js --project-root <root>` — no vscode
  // dependency.
  const mcpCtx = await esbuild.context({
    entryPoints: [path.join(__dirname, "..", "mcp-server", "src", "bin.ts")],
    outfile: path.join(outdir, "mcp", "bin.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    sourcemap: true,
    minify: false,
    external: ["@4d/parser-4d"],
    logLevel: "info",
  });

  copyWasmAssets();
  copyWebviewAssets();

  if (watch) {
    await ctx.watch();
    await mcpCtx.watch();
    console.log("[esbuild] watching…");
  } else {
    await ctx.rebuild();
    await mcpCtx.rebuild();
    await ctx.dispose();
    await mcpCtx.dispose();
    console.log("[esbuild] bundles written → dist/extension.js, dist/mcp/bin.js");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
