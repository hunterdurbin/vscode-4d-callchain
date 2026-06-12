# 4D Call Chain Explorer

[![Open VSX](https://img.shields.io/open-vsx/v/hunterdurbin/vscode-4d-callchain?label=Open%20VSX)](https://open-vsx.org/extension/hunterdurbin/vscode-4d-callchain)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

VS Code extension for navigating call chains in 4D v21 projects.

> **Note:** the Visual Studio Marketplace listing is temporarily unavailable while we resolve an
> automated-scan false positive with Microsoft. Install from Open VSX or the `.vsix` below in the
> meantime.

## Install

- **VS Code / Cursor:** download the `.vsix` from the [latest release](https://github.com/hunterdurbin/vscode-4d-callchain/releases)
  and run `code --install-extension vscode-4d-callchain-<version>.vsix`.
- **VSCodium / any Open VSX editor:** install from [Open VSX](https://open-vsx.org/extension/hunterdurbin/vscode-4d-callchain),
  or search **"4D Call Chain Explorer"** in the Extensions view.

For 4D **syntax highlighting**, also install [`4D.4d-analyzer`](https://marketplace.visualstudio.com/items?itemName=4D.4d-analyzer)
(the official 4D extension). Call Chain Explorer provides the call-graph navigation; the analyzer
provides the grammar and themes. They're independent — install whichever you need.

## Features

- **Callers** and **Callees** trees in the activity bar (updates as you move the cursor)
- **Method Trace window** — unrolls the whole call chain from a method as an expandable tree, one row per call site in source order, with symbol-kind filters
- **CodeLens** above every function: `N callers • N callees • tests cover • Run`
- **Test integration** — JUnit XML parsing, run `make test` from gutter, coverage hints
- Recognizes 4D's full call surface:
  - Project methods (`Foo()`)
  - Class functions on entities (`entity.fn()`), entity selections, dataclasses (`ds.X.fn()`), datastore
  - Constructors (`cs.X.new()`)
  - `This.fn()`, `Super(...)`, inheritance via `Class extends`
  - `CALL WORKER`, `New process`, `EXECUTE METHOD`, `Formula(...)`
  - Plugins and built-in commands

## Development

```bash
npm install
npm run compile
# Then press F5 in VS Code to launch the dev host
```

## Syntax highlighting & building

Syntax highlighting (the TextMate grammar, themes, and the `4d` language) is
owned by [`4D.4d-analyzer`](https://marketplace.visualstudio.com/items?itemName=4D.4d-analyzer).
Call Chain Explorer ships **navigation only** and does **not** contribute its own
`4d` grammar, so the two extensions never fight over the `source.4dm` scope —
install the analyzer alongside it if you want highlighting.

Two `.vsix` variants:

- `make vsix` — the default, lean Call-Chain-only build. No dependencies; pairs
  with `4D.4d-analyzer` for syntax highlighting if you have it installed. This is
  the build published to the Marketplace and Open VSX.
- `make vsix-full` → `vscode-4d-callchain-<version>-full.vsix` — a standalone
  build that additionally bundles its own 4D grammar/themes, for environments
  where `4D.4d-analyzer` can't be installed. (Build-time only; VS Code can't
  toggle a contributed grammar at runtime.)

## Settings

Settings are grouped into titled sections in the Settings UI (search for
"4D Call Chain"). The most useful keys:

**Indexing**
- `callchain.index.projectRoot` — path to 4D project root (the folder containing `Project/`). Defaults to first workspace folder.
- `callchain.index.exclusions` — folder names skipped while indexing.
- `callchain.index.autoOnStartup` — build/load the index on activation (default on).

**Language Server**
- `callchain.server.enabled` — run the 4D language server (definitions, references, call hierarchy, semantic tokens, diagnostics/linter, hover, completion, signature help) in its own process.

**Code Lenses** — `callchain.codeLens.show*` toggles for each lens kind (callers, callees, via-base, graph, trace, overrides, overriding, extended-by, property usage).

**Views & Graph**
- `callchain.views.showCallSiteSnippets` — code snippets on call-site rows.
- `callchain.trace.hiddenKinds` — symbol-kind categories hidden by default in the Method Trace view.

**Coverage**
- `callchain.coverage.showHints` — gutter markers for uncovered functions.
- `callchain.coverage.testFunctionPattern` / `testClassPattern` / `testMethodPattern` — what counts as a test.

**Testing**
- `callchain.tests.enabled` — the optional test-integration subsystem (run commands, pass/fail gutter, results watcher).
- `callchain.tests.command` — command template (default: `make test class={class} format=json outputPath={jsonOutputPath}`).
- `callchain.tests.jsonResultsPath` — relative path to the JSON results file.

**Lint**
- `callchain.lint.rules` — per-rule severity + options for the built-in linter (eleven rules across `types/`, `decl/`, `unused/`, `style/` themes; all off by default). See [docs/lint-rules.md](docs/lint-rules.md).

**MCP**
- `callchain.mcp.binPath` — explicit path to the MCP server binary for packaged installs.

> **Upgrading from ≤0.1.x:** settings were renamed in 0.2.0 with no aliases.
> Old → new: `projectRoot`→`index.projectRoot`, `indexExclusions`→`index.exclusions`,
> `builtinConstantsPaths`→`index.builtinConstantsPaths`, `autoIndexOnStartup`→`index.autoOnStartup`,
> `languageServer.enabled`→`server.enabled` (`ideServer.enabled` removed — the two servers merged),
> `showCallSiteSnippets`→`views.showCallSiteSnippets`,
> `showCoverageHints`→`coverage.showHints`, `testIntegration.enabled`→`tests.enabled`,
> `testCommand`→`tests.command`, `jsonResultsPath`→`tests.jsonResultsPath`
> (`junitResultsPath` removed — JSON results only), `mcpServer.binPath`→`mcp.binPath`.

## MCP server (for AI agents)

The same call-graph engine is exposed to AI agents (Claude Code, Cursor, or any
[MCP](https://modelcontextprotocol.io) client) through a standalone server in
`packages/mcp-server`. It loads the shared index cache the extension already
writes (`<projectRoot>/.vscode/callchain-index-*.msgpack`) — so startup is
near-instant when the extension has indexed once — and watches that cache to
stay in sync as you save.

**Quick setup:** run the **4D Call Chain: Copy MCP server config for AI agents**
command from the Command Palette. It resolves the server path and the current
project root, then lets you pick target(s) — Claude Code (project `.mcp.json` or
global `~/.claude.json`), Cursor (`.cursor/mcp.json`), VS Code/Copilot
(`.vscode/mcp.json`) — and copies a ready-to-paste JSON snippet to your
clipboard, annotated with the file each one belongs in. The extension never
edits agent config files itself. When running from a packaged `.vsix` (where
the server isn't bundled), point `callchain.mcp.binPath` at the server's
`dist/bin.js`.

To wire it up by hand instead, build the monorepo (`npm run build`) and register
the server with your agent. For Claude Code, add to `.mcp.json`:

```json
{
  "mcpServers": {
    "4d-callchain": {
      "command": "node",
      "args": [
        "/abs/path/to/vscode-4d-callchain/packages/mcp-server/dist/bin.js",
        "--project-root",
        "/abs/path/to/your/4d/project"
      ]
    }
  }
}
```

If the project has never been indexed, the server cold-builds the index itself
(regex parser, no native tree-sitter binding required).

Available tools:

| Tool | What it answers |
|------|-----------------|
| `search_symbols` | Find methods/classes/functions/constants by name (exact → prefix → fuzzy). |
| `get_symbol` | Signature, location, and caller/callee counts for one symbol. |
| `find_callers` / `find_callees` | Incoming / outgoing call edges with call-site lines. |
| `reachable` | Bounded BFS (depth + direction) from a symbol. |
| `call_path` | Shortest call path between two symbols. |
| `class_hierarchy` | Ancestors, direct subclasses, and all descendants of a class. |
| `find_overrides` / `find_overridden` | Override relationships for class functions. |
| `reindex` | Force a full rebuild (rarely needed). |

Tools accept a stable `symbolId` (from a prior result) or a `name` with optional
`kind` / `ownerClass` to disambiguate; an ambiguous name returns the candidate
list. Run `node packages/mcp-server/dist/bin.js --project-root <path>` under
[`@modelcontextprotocol/inspector`](https://github.com/modelcontextprotocol/inspector)
to explore the tools interactively.

## Linting

The extension ships eleven best-practices lint rules. Every rule is off
by default — enable the ones you want by adding entries under
`callchain.lint.rules`:

```jsonc
"callchain.lint.rules": {
  "unused/parameter": "warning",
  "decl/implicit-local": "warning",
  "style/builtin-name-collision": "error",
  "unused/method-no-callers": {
    "severity": "warning",
    "options": { "entrypointPattern": "^(On |RPC_)" }
  }
}
```

Inline suppression works with any 4D comment style:

```4d
// lint-disable-next-line unused/parameter
Function process($unused : Text; $real : Text)
```

See [docs/lint-rules.md](docs/lint-rules.md) for the full rule reference,
per-rule options, and suppression syntax.
