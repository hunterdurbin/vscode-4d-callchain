# Backlog

Snapshot of remaining work across the monorepo (`@4d/core`, `@4d/language-server`, `@4d/ide-server`, `vscode-4d-callchain`).

Effort estimates: **XS** < 30 min · **S** ~1 hr · **M** ~half-day · **L** ~1–2 days · **XL** multi-day.

---

## IDE features (LSP methods still missing)

| # | Item | Effort | Notes |
|---|---|---|---|
| 1 | ~~`$var.` completion~~ ✅ | M | Local-type inference done on-the-fly via `inferLocals()` (no index plumbing — re-parses the enclosing function on each request). Handles `cs.X`, `cs.NS.X`, `EntitySelection<T>`, primitives. Multi-step chains (`$x.foo().bar.`) still go through the resolver at index time only. |
| 2 | ~~Signature help (`textDocument/signatureHelp`)~~ ✅ | M | Param names + types persisted on every `ClassFunction` / `ProjectMethod` / `ClassConstructor` symbol (INDEX_VERSION 25). Resolves free names, `This.method`, `cs.X.method`, `cs.NS.X.method`. `$x.method` is a follow-up. |
| 3 | ~~Diagnostics (`textDocument/publishDiagnostics`)~~ ✅ | M | Push warnings for unresolved edges in the open file. Pre-existing noise dropped 86 % (71k → 10k unresolved) by adding legacy C_LONGINT/etc. to BUILTIN_SET. Per-file cap of 100 keeps the Problems panel usable on legacy files. |
| 4 | ~~Semantic tokens (`textDocument/semanticTokens`)~~ ✅ | M | Legend: function / method / class / property / parameter / variable / keyword / comment / string / number / macro; modifiers: defaultLibrary / deprecated / static. Tokens for symbol defs + call sites; builtins get the defaultLibrary modifier. |
| 5 | ~~Document highlight (`textDocument/documentHighlight`)~~ ✅ | S | Read kind for call sites (uses A.1 column ranges), Write kind for in-file declarations. |
| 6 | Rename refactoring (`textDocument/rename`) | L | Deferred. Foundation (column ranges on every CallEdge) is now in place. When taken up: rename project methods, class functions, getters/setters, properties, and locals. |
| 7 | ~~Folding ranges (`textDocument/foldingRange`)~~ ✅ | S | Shared `scanBlocks()` in `@4d/core` handles If / Case / For / While / Repeat / Function / Class. |
| 8 | ~~Selection range (`textDocument/selectionRange`)~~ ✅ | S | Reuses `scanBlocks()`. word → paren expression → statement → blocks → file. |

## Indexer / core

| # | Item | Effort | Notes |
|---|---|---|---|
| 9 | ~~Incremental indexing~~ ✅ | M–L | `patchFile()` now diffs per-file. INDEX_VERSION 27 adds `fileOrigins[]` reference-counting on synthetic symbols; `Indexer` keeps warm caches (`parsedByPath`, `edgesByFromId`, `edgesByNameKey` reverse-name index) populated at the tail of `rebuild()`. Cross-file fan-out re-resolves only the call sites that referenced names the patched files added/removed. `patchFiles()` batches `onDidChangeWatchedFiles` so a rename emits one update. Fallbacks: full rebuild on cold caches, non-`.4dm` changes, batches > 50, or synth refcount drift. |
| 10 | ~~File watching gaps~~ ✅ | S | Watchers now cover `Project/Sources/catalog.4DCatalog`, `Resources/Constants_*.xlf`, and `Components/**/*.{4DZ,4dz}` in the in-process indexer + both LSP clients. `classifyChange()` routes each watcher event to either the existing `.4dm` surgical path or a single full rebuild; mixed batches dispatch on most-aggressive-wins. `isFresh()` now samples `catalogMtime` / `constantsMtimes` / `componentMtimes` and detects file-set membership changes so offline edits invalidate the cache. INDEX_VERSION 27 → 28. |
| 11 | ~~Per-workspace cache paths~~ ✅ | S | Cache filename is now `callchain-index-<12char-hash>.msgpack` where the hash is a sha256 prefix of `path.resolve(projectRoot)`. Two projects sharing one `.vscode/` co-exist instead of forcing a rebuild on every switch. Pre-v29 caches are silently orphaned (one forced rebuild on upgrade). `Indexer.getCachePath()` exposes the resolved path for tests + diagnostics. |
| 12 | ~~Component class columns~~ ✅ | XS | Investigated — as of 4D v21 the `.4DZ` format ships compiled bytecode + metadata only (`classes.json`, `methodAttributes.json`, `settings.4DSettings`, binary `MX64`/`IX64`). No `.4dm` source is embedded in any of the symphony components, so there is nothing to read for source positions. Documented the constraint in `componentScanner.ts` and `nameResolver.ts`; `test/unit/componentSymbols.test.ts` locks in the line-only behavior and the `ownerComponent` marker downstream features use to detect compiled-bundle origin. |
| 13 | Tree-sitter / proper parser — *in progress* | XL | New `@4d/parser-4d` workspace ships a hand-written tree-sitter grammar (10 corpus-test files, 131 tests passing) compiled to WASM. `@4d/core` consumes it via `web-tree-sitter`. Behind `FOURD_PARSER=treesitter` env flag — sync parser dispatch in `fileParser.ts:130` falls through to the legacy regex parser when the flag is off or init hasn't run. Mini-4d parity: 97 % symbols (74/76), 92 % calls (96/104). Remaining work: bring call parity to ≥99.5 %, flip the default, delete `callExtractor.ts`, rewrite `blockScanner.ts`/`variableScanner.ts` as CST walks, then bump INDEX_VERSION. WASM-based runtime avoids the cross-platform native-binding distribution problem (Node 25's V8 headers broke the native build path). |

## Editor integration / polish

| # | Item | Effort | Notes |
|---|---|---|---|
| 14 | VSIX packaging | M | Bundle ide-server + language-server binaries into the published VSIX. Today only F5 works because the workspace symlink resolves. |
| 15 | Neovim setup docs | S | README snippet for `nvim-lspconfig` pointing at both server binaries. |
| 16 | JetBrains setup docs | S | LSP4IJ snippet. |
| 17 | CallChain views via LSP | L | The VSCode extension's tree views still use the in-process `Indexer` directly. Could route through `$/callchain/*` custom LSP requests for full editor-agnostic UX. Big refactor. |

## Tests / tooling

| # | Item | Effort | Notes |
|---|---|---|---|
| 18 | ~~Real test suite~~ ✅ | M | vitest. `test/unit/*` runs anywhere (no fixture). `test/indexer/*`, `test/lsp/*`, `test/ide/*` self-skip unless `FOURD_TEST_PROJECT` is set (defaults to `test/fixtures/mini-4d`). Shared `SymbolIndex` per worker via `isolate:false` keeps the full suite under 6s on the mini-fixture (~5 min on Symphony). |
| 19 | CI (workflow) — fixture done ✅, CI workflow pending | S | Fixture: `test/fixtures/mini-4d/` — ~50 hand-crafted `.4dm`/`.4DForm`/`.json`/`.xlf` files exercising every parser pattern in `callExtractor.ts` + `fileParser.ts`. Each file has a `// LOCKS:` header naming the regression it pins. Deterministic specs at `test/indexer/mini-{counts,resolution,form}.test.ts` assert exact symbol/edge counts. Set `FOURD_TEST_PROJECT=/path/to/symphony` to run against a real volume project. **Remaining**: GitHub Actions/GitLab CI workflow file. |

## Cleanup / debt

| # | Item | Effort |
|---|---|---|
| 20 | Unused imports (`RawCallSite`, `FileLocation`) | XS |
| 21 | cSpell warnings (Interprocess, ORDA, vmatch, etc.) | XS |
| 22 | `patchFile` could batch rapid file changes via debounce | S |
| 23 | Caller-count caches O(N) on first miss — precompute once per index | S |

---

## Recommended next 3

1. **Rename** (#6) — column ranges are in the index, so the precise call-site replacements rename needs are available.
2. **`#DECLARE(...)->$return : Type` return-variable capture** — would let `$return.` completion work inside methods that declare an output via the arrow form.
3. **Tree-sitter / proper parser** (#13) — replace regex parsing with a hand-built grammar. Largest item left and the biggest unlock for "correct in unusual formatting" cases.
