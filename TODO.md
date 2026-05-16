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
| 9 | Incremental indexing | M–L | `patchFile()` currently does a full rebuild (~25s on symphony). Replace with per-file diff. Biggest UX win after the initial index. |
| 10 | File watching gaps | S | We watch `.4dm` only. Missing: `.4DCatalog`, `Resources/Constants_*.xlf`, component `.4DZ`, `Catalog/Tables/*.json`. Each requires a partial reindex. |
| 11 | Per-workspace cache paths | S | Multiple 4D projects open in one VSCode window collide on `.vscode/callchain-index.json`. |
| 12 | Component class columns | M | 664 ClassFunction symbols are line-only because they come from `.4DZ` `classes.json`. Could read the `.4DZ`'s embedded source if present, or accept line-only behavior. |
| 13 | Tree-sitter / proper parser | XL | Replace regex parsing. Handles multi-line function signatures, unusual formatting, embedded SQL. No published 4D grammar — would need to hand-write or hand-build one. |

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
| 18 | Real test suite | M | Currently just smoke scripts. Move to vitest/mocha with assertions on specific symbol/edge counts. |
| 19 | CI | S | Lint + smoke against a fixture 4D project on each push. Need a small fixture committed somewhere. |

## Cleanup / debt

| # | Item | Effort |
|---|---|---|
| 20 | Unused imports (`RawCallSite`, `FileLocation`) | XS |
| 21 | cSpell warnings (Interprocess, ORDA, vmatch, etc.) | XS |
| 22 | `patchFile` could batch rapid file changes via debounce | S |
| 23 | Caller-count caches O(N) on first miss — precompute once per index | S |

---

## Recommended next 3

1. **Incremental indexing** (#9) — eliminates the save-feels-slow problem; now the only large UX gap left.
2. **Rename** (#6) — column ranges are now in the index, so the precise call-site replacements rename needs are available.
3. **`#DECLARE(...)->$return : Type` return-variable capture** — would let `$return.` completion work inside methods that declare an output via the arrow form.
