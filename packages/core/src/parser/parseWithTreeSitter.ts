/**
 * Tree-sitter parsing entry point.
 *
 * Owns the lifecycle of the `web-tree-sitter` parser: lazily initializes
 * the WASM runtime and language on first use, then exposes a synchronous
 * `parseFileWithTreeSitter()` for the indexer.
 *
 * Phase 8 (TODO #13): a small LRU keeps the last N parsed Trees so a
 * second parse of the same file can be incremental. Each "edit" is
 * derived from a prefix/suffix-elimination diff against the previous
 * source — one Edit object spanning the changed middle. Tree-sitter
 * then walks only the affected subtree, which can be 100× faster on
 * large files (3kLOC test file: 730 ms cold → ~15 ms incremental).
 */

import * as fs from "fs";
import { Parser, Language, Tree } from "web-tree-sitter";
// `@4d/parser-4d` doesn't ship .d.ts files; declare what we use from it.
const parser4d: { wasmPath: string } = require("@4d/parser-4d");
import type { DiscoveredFile } from "../indexer/projectScanner";
import type { ParsedFile } from "../indexer/fileParser";
import { CstVisitor } from "./cstVisitor";

let parser: Parser | null = null;
let language: Language | null = null;

interface CachedParse {
  source: string;
  tree: Tree;
}

// LRU cache of recent parses, keyed by absolute path. Capped at 256 entries
// — large enough for the active editing surface (open documents and their
// neighbors that get patched together) but small enough to keep total
// memory bounded. Symphony has 25k files; we'd never want to cache them
// all (tens of MB per Tree, gigabytes total). Files that aren't re-parsed
// (i.e. the bulk of the project after the initial rebuild) never enter
// the cache.
const CACHE_LIMIT = 256;
const treeCache = new Map<string, CachedParse>();

function cacheGet(path: string): CachedParse | undefined {
  const v = treeCache.get(path);
  if (!v) return undefined;
  // Re-insert to mark as most-recently-used.
  treeCache.delete(path);
  treeCache.set(path, v);
  return v;
}

function cacheSet(path: string, entry: CachedParse): void {
  if (treeCache.has(path)) {
    treeCache.delete(path);
  } else if (treeCache.size >= CACHE_LIMIT) {
    // Evict the oldest entry — first key in insertion order.
    const oldest = treeCache.keys().next().value;
    if (oldest !== undefined) {
      const evicted = treeCache.get(oldest);
      treeCache.delete(oldest);
      evicted?.tree.delete();
    }
  }
  treeCache.set(path, entry);
}

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
  const tree = parseIncremental(file.absolutePath, source);
  if (!tree) {
    throw new Error(`Failed to parse ${file.absolutePath}`);
  }
  // CONTRACT: the caller passes constant names already lowercased — both
  // the indexer (indexStore.doRebuild) and the patch path (indexStore
  // .patchFiles) lowercase once when building the set. Re-lowercasing
  // here per-file cost ~5k toLowerCase() × 27k files = 135M ops on
  // Symphony cold load, all redundant.
  const constants =
    constantsSet && constantsSet.size > 0 ? constantsSet : undefined;
  const visitor = new CstVisitor(file, source, constants);
  return visitor.visit(tree.rootNode);
}

/**
 * Parse a source string, using the cached previous tree for incremental
 * reparsing when available. Updates the cache with the new (source, tree)
 * pair before returning.
 */
function parseIncremental(absPath: string, source: string): Tree {
  const cached = cacheGet(absPath);
  if (!cached) {
    const fresh = parser!.parse(source);
    if (!fresh) throw new Error(`Failed to parse ${absPath}`);
    cacheSet(absPath, { source, tree: fresh });
    return fresh;
  }

  // Compute the minimal Edit spanning the changed middle via prefix /
  // suffix elimination. For a single-keystroke change, this Edit is
  // 1 byte wide; for "Save All" after a typing burst, it's larger but
  // still bounded by the changed region.
  const edit = computeEdit(cached.source, source);
  if (edit) {
    cached.tree.edit(edit);
  }
  const newTree = parser!.parse(source, cached.tree);
  if (!newTree) throw new Error(`Failed to incremental-parse ${absPath}`);
  // Old tree is now stale; release it before overwriting the cache slot.
  cached.tree.delete();
  cacheSet(absPath, { source, tree: newTree });
  return newTree;
}

interface TreeSitterEdit {
  startIndex: number;
  oldEndIndex: number;
  newEndIndex: number;
  startPosition: { row: number; column: number };
  oldEndPosition: { row: number; column: number };
  newEndPosition: { row: number; column: number };
}

/**
 * Build a single tree-sitter Edit that covers the changed bytes between
 * `oldSource` and `newSource`. Returns null when the sources are
 * identical (no edit needed) — tree-sitter still re-checks the tree, but
 * with no shifted positions.
 *
 * The Edit spans from the first byte where the sources differ to the
 * last byte where they differ (i.e. `oldSource.length - commonSuffix`
 * and `newSource.length - commonSuffix`). For a small change in a
 * large file this is the minimum information tree-sitter needs to keep
 * its incremental algorithm tight.
 */
function computeEdit(
  oldSource: string,
  newSource: string,
): TreeSitterEdit | null {
  if (oldSource === newSource) return null;
  // Find the first byte that differs.
  const minLen = Math.min(oldSource.length, newSource.length);
  let prefix = 0;
  while (prefix < minLen && oldSource[prefix] === newSource[prefix]) {
    prefix++;
  }
  // Find the first byte from the end that differs. Don't let prefix and
  // suffix overlap.
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldSource[oldSource.length - 1 - suffix] ===
      newSource[newSource.length - 1 - suffix]
  ) {
    suffix++;
  }
  const startIndex = prefix;
  const oldEndIndex = oldSource.length - suffix;
  const newEndIndex = newSource.length - suffix;

  return {
    startIndex,
    oldEndIndex,
    newEndIndex,
    startPosition: byteOffsetToPoint(oldSource, startIndex),
    oldEndPosition: byteOffsetToPoint(oldSource, oldEndIndex),
    newEndPosition: byteOffsetToPoint(newSource, newEndIndex),
  };
}

/** Translate a byte offset into a `{row, column}` Point in `source`. */
function byteOffsetToPoint(source: string, offset: number): {
  row: number;
  column: number;
} {
  let row = 0;
  let column = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") {
      row++;
      column = 0;
    } else {
      column++;
    }
  }
  return { row, column };
}

/**
 * Drop the cached Tree for a path — call on file delete so we don't
 * leak Trees nor produce stale incremental parses if the path is
 * reused.
 */
export function invalidateTreeCache(absPath: string): void {
  const cached = treeCache.get(absPath);
  if (cached) {
    cached.tree.delete();
    treeCache.delete(absPath);
  }
}

/**
 * Check if the tree-sitter parser is initialized. Allows callers to gate
 * the FOURD_PARSER=treesitter path without forcing an `await` chain in
 * sync code that may run before init completes.
 */
export function isTreeSitterReady(): boolean {
  return parser !== null;
}
