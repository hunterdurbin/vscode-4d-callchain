/**
 * Tree-sitter parsing entry point.
 *
 * Owns the lifecycle of the `web-tree-sitter` parser: lazily initializes
 * the WASM runtime and language on first use, then exposes a synchronous
 * `parseFileWithTreeSitter()` for the indexer.
 *
 * Phase 5 of the migration plan (see TODO.md #13). Behind the
 * `FOURD_PARSER=treesitter` env flag for A/B testing against the legacy
 * regex parser. Phase 6 flips the default.
 */

import * as fs from "fs";
import { Parser, Language } from "web-tree-sitter";
// `@4d/parser-4d` doesn't ship .d.ts files; declare what we use from it.
const parser4d: { wasmPath: string } = require("@4d/parser-4d");
import type { DiscoveredFile } from "../indexer/projectScanner";
import type { ParsedFile } from "../indexer/fileParser";
import { CstVisitor } from "./cstVisitor";

let parser: Parser | null = null;
let language: Language | null = null;

/**
 * Initialize the tree-sitter runtime and load the 4D grammar. Must be
 * called once at process startup before `parseFileWithTreeSitter()`.
 * Returns immediately if already initialized.
 */
export async function initTreeSitterParser(): Promise<void> {
  if (parser) return;
  await Parser.init();
  const wasmPath = parser4d.wasmPath;
  language = await Language.load(wasmPath);
  parser = new Parser();
  parser.setLanguage(language);
}

/**
 * Parse a single .4dm file using tree-sitter and produce a `ParsedFile`
 * matching the legacy regex parser's contract.
 *
 * Throws if `initTreeSitterParser()` hasn't been called.
 */
export function parseFileWithTreeSitter(
  file: DiscoveredFile,
  constantsSet?: Set<string>,
): ParsedFile {
  if (!parser) {
    throw new Error(
      "Tree-sitter parser not initialized; call initTreeSitterParser() first",
    );
  }
  const source = fs.readFileSync(file.absolutePath, "utf8");
  const tree = parser.parse(source);
  if (!tree) {
    throw new Error(`Failed to parse ${file.absolutePath}`);
  }
  // The legacy regex parser expects constant names in lowercase for its
  // case-insensitive lookup. Normalize once here so the visitor doesn't
  // have to lowercase on every check.
  const constants =
    constantsSet && constantsSet.size > 0
      ? new Set(Array.from(constantsSet, (s) => s.toLowerCase()))
      : undefined;
  const visitor = new CstVisitor(file, source, constants);
  return visitor.visit(tree.rootNode);
}

/**
 * Check if the tree-sitter parser is initialized. Allows callers to gate
 * the FOURD_PARSER=treesitter path without forcing an `await` chain in
 * sync code that may run before init completes.
 */
export function isTreeSitterReady(): boolean {
  return parser !== null;
}
