"use strict";

const path = require("node:path");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..", "..");

let binding;
if (typeof process.versions.bun === "string") {
  // Support `bun build --compile` by being statically analyzable enough to find
  // the .node file at build-time.
  binding = require(`${root}/prebuilds/${process.platform}-${process.arch}/tree-sitter-fourd.node`);
} else {
  binding = require("node-gyp-build")(root);
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

module.exports = binding;
