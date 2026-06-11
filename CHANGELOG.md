# Changelog

All notable changes to the **4D Call Chain Explorer** extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-06-11

### Changed — BREAKING: settings renamed (no aliases)
Settings are now grouped into titled sections with proper scopes. Old keys are
no longer read; re-apply your values under the new names:

| Old | New |
| --- | --- |
| `callchain.projectRoot` | `callchain.index.projectRoot` |
| `callchain.indexExclusions` | `callchain.index.exclusions` |
| `callchain.builtinConstantsPaths` | `callchain.index.builtinConstantsPaths` |
| `callchain.autoIndexOnStartup` | `callchain.index.autoOnStartup` |
| `callchain.languageServer.enabled` | `callchain.server.enabled` |
| `callchain.ideServer.enabled` | _removed_ (servers merged) |
| `callchain.showCallSiteSnippets` | `callchain.views.showCallSiteSnippets` |
| `callchain.maxGraphDepth` | `callchain.graph.maxDepth` |
| `callchain.showCoverageHints` | `callchain.coverage.showHints` |
| `callchain.testIntegration.enabled` | `callchain.tests.enabled` |
| `callchain.testCommand` | `callchain.tests.command` |
| `callchain.jsonResultsPath` | `callchain.tests.jsonResultsPath` |
| `callchain.junitResultsPath` | _removed_ (JSON results only) |
| `callchain.mcpServer.binPath` | `callchain.mcp.binPath` |

`callchain.codeLens.*`, `callchain.coverage.test*Pattern`, and
`callchain.lint.rules` are unchanged.

### Changed
- The IDE server (hover, completion, signature help) merged into the language
  server: one process, one index, one watcher set — half the duplicate
  indexing work when LSP features are enabled.
- Saving is dramatically lighter on large projects. The incremental patch
  path no longer rebuilds O(all-symbols) resolver tables per save (a
  persistent, incrementally-maintained scratch replaces them), the name-key
  bookkeeping touches only the saved file's buckets, and the cache encode
  never runs on the extension-host thread between saves: the language server
  is the sole cache writer when running, and solo installs write on a 5s
  idle debounce flushed at shutdown. This stops the extension from slowing
  other extensions' save participants (e.g. format-on-save).
- Coverage ("N tests cover this" / uncovered hints) computes on a 1.5s
  trailing timer after a save burst instead of synchronously on every save.
- Code lenses, the cursor tracker, and the dirty-line tracker look up the
  current file's symbols via a maintained by-URI index instead of scanning
  every project symbol per request/keystroke.
- Cold rebuilds overlap disk reads with parsing (sliding read-ahead window).

### Fixed
- Toggling `callchain.codeLens.showViaBase` / `showPropertyUsage` now
  refreshes lenses immediately.
- Editing a class no longer leaves deleted properties resolvable through
  stale chain-walk metadata.
- The test-status and coverage-hint decorators no longer leak their editor
  listeners, re-scan the full document on every keystroke, or leave stale
  gutter decorations behind; the test-status decorator (and its listeners)
  exists only when test integration is enabled.
- "Run" code lenses no longer appear (and silently fail) when test
  integration is disabled.

### Removed
- The JUnit XML results fallback (`junitResultsPath`, the JUnit parser, and
  the `.xml` watcher) — the JSON results path is the only supported format.

## [0.1.18] - 2026-06-10

### Fixed
- README marketplace version badge switched from the retired shields.io
  `visual-studio-marketplace` endpoint to `vsmarketplacebadges.dev`.

## [0.1.17] - 2026-06-10

### Added
- **Class Properties** group in the Symbols panel.
- Test-method pattern marking `UT_` project methods as tests.

### Changed
- Click navigation now lands on the identifier and selects the token.
- A class with no constructor shows "N callers" at the top.

## [0.1.16] - 2026-06-10

First public release.

### Added
- **Callers** and **Callees** trees in the activity bar that update as you move the cursor.
- **Graph view** (Cytoscape.js) with a depth slider, direction toggle, and color-coding by symbol kind.
- **CodeLens** above each function: caller/callee counts, test coverage, and a Run action.
- **Test integration** — JUnit XML parsing, run tests from the gutter, coverage hints.
- Full 4D call-surface resolution: project methods, class functions on entities/entity
  selections/dataclasses/datastore, `cs.X.new()` constructors, `This.fn()`, `Super(...)`,
  `Class extends` inheritance, `CALL WORKER`, `New process`, `EXECUTE METHOD`, `Formula(...)`,
  plugins, and built-in commands.
- Class-property indexing with read/write usage, plus a read/write filter on the Callers view.
- Polymorphic-dispatch (via base) callers surfaced in the editor UI.
- Built-in linter with eleven best-practices rules (all off by default) and inline suppression.
- Standalone **MCP server** exposing the call graph to AI agents, with a setup command.

[0.1.16]: https://github.com/hunterdurbin/vscode-4d-callchain/releases/tag/v0.1.16
