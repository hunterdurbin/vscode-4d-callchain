"use strict";

const path = require("node:path");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..", "..");

// Absolute path to the WASM build of the parser, for use with
// `web-tree-sitter`. The native binding (below) targets `tree-sitter` (the
// Node package) which is faster but requires ABI-compatible Node versions.
// On Node 25+ the native runtime is currently broken, so consumers prefer
// the WASM path.
const wasmPath = path.join(root, "tree-sitter-fourd.wasm");

// Try to load the native binding; tolerate failure so consumers can still
// access `wasmPath` for `web-tree-sitter` even when the native ABI doesn't
// match (e.g. tree-sitter@0.22's prebuilt runtime is broken on Node 25).
let binding;
try {
  if (typeof process.versions.bun === "string") {
    binding = require(`${root}/prebuilds/${process.platform}-${process.arch}/tree-sitter-fourd.node`);
  } else {
    binding = require("node-gyp-build")(root);
  }
} catch {
  binding = {};
}

try {
  binding.nodeTypeInfo = require(`${root}/src/node-types.json`);
} catch {
  // Missing node-types.json is fine before the parser is generated.
}

const queries = [
  ["HIGHLIGHTS_QUERY", `${root}/queries/highlights.scm`],
  ["INJECTIONS_QUERY", `${root}/queries/injections.scm`],
  ["LOCALS_QUERY", `${root}/queries/locals.scm`],
  ["TAGS_QUERY", `${root}/queries/tags.scm`],
];

for (const [prop, queryPath] of queries) {
  Object.defineProperty(binding, prop, {
    configurable: true,
    enumerable: true,
    get() {
      delete binding[prop];
      try {
        binding[prop] = fs.readFileSync(queryPath, "utf8");
      } catch {
        // Query file may not exist yet; that's fine.
      }
      return binding[prop];
    },
  });
}

// Expose the WASM path even when the native binding isn't loaded; consumers
// using `web-tree-sitter` use this to find the .wasm file in the published
// package layout.
binding.wasmPath = wasmPath;

module.exports = binding;
