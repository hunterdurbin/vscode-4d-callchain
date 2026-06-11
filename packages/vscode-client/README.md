# 4D Call Chain Explorer

[![Open VSX](https://img.shields.io/open-vsx/v/hunterdurbin/vscode-4d-callchain?label=Open%20VSX)](https://open-vsx.org/extension/hunterdurbin/vscode-4d-callchain)

Navigate call chains in [4D](https://us.4d.com/) v21 projects — methods, class functions, and plugins — right inside VS Code.

## Features

- **Callers** and **Callees** trees in the activity bar (update as you move the cursor)
- **Butterfly graph** rendered with Cytoscape.js — callers left, callees right; single-click re-centers, double-click opens the editor, visited nodes stay marked
- **Method Trace window** — unrolls the whole call chain from a method as an expandable tree, one row per call site in source order, with symbol-kind filters
- **CodeLens** above every function: `N callers • N callees • tests cover • Run`
- **Test integration** — JUnit XML parsing, run tests from the gutter, coverage hints
- Recognizes 4D's full call surface:
  - Project methods (`Foo()`)
  - Class functions on entities (`entity.fn()`), entity selections, dataclasses (`ds.X.fn()`), datastore
  - Constructors (`cs.X.new()`)
  - `This.fn()`, `Super(...)`, inheritance via `Class extends`
  - `CALL WORKER`, `New process`, `EXECUTE METHOD`, `Formula(...)`
  - Plugins and built-in commands
- Built-in linter with eleven best-practices rules (all off by default)
- Optional **MCP server** that exposes the same call graph to AI agents

## Recommended

For 4D **syntax highlighting**, also install [`4D.4d-analyzer`](https://marketplace.visualstudio.com/items?itemName=4D.4d-analyzer)
(the official 4D extension). Call Chain Explorer provides call-graph navigation; the analyzer
provides the grammar and themes. They're independent — neither requires the other.

## Settings

- `callchain.index.projectRoot` — path to the 4D project root (the folder containing `Project/`). Defaults to the first workspace folder.
- `callchain.tests.command` — test command template (default: `make test class={class} format=json outputPath={jsonOutputPath}`).
- `callchain.tests.jsonResultsPath` — relative path to the JSON test results file.
- `callchain.graph.maxDepth` — caller/callee levels per side of the butterfly graph.
- `callchain.trace.hiddenKinds` — symbol-kind categories hidden by default in the Method Trace view.
- `callchain.coverage.showHints` — gutter markers for uncovered functions.
- `callchain.lint.rules` — per-rule severity + options for the built-in linter (all off by default).

See the [full settings reference](https://github.com/hunterdurbin/vscode-4d-callchain#readme) for the complete list.

## Security & privacy

Everything runs locally; the extension makes **no network requests** and collects no telemetry.

- Parsing uses [web-tree-sitter](https://github.com/tree-sitter/tree-sitter) compiled to **WebAssembly** — no native binaries ship in the package.
- The extension spawns exactly two kinds of local processes: the bundled language server
  (via the standard `vscode-languageclient` IPC transport), and — only when you click `▶ Run` —
  **your own** `callchain.tests.command`, echoed verbatim to the output channel before it runs.
- The optional MCP setup (`4D Call Chain: Copy MCP server config for AI agents`) never writes any
  files: it only copies a ready-to-paste JSON snippet to your clipboard, annotated with the agent
  config file it belongs in. Editing your agent configs is always left to you.
- The graph and trace views are local webviews with a strict Content-Security-Policy; no remote scripts.

Source is fully open and the published package is built from it: [github.com/hunterdurbin/vscode-4d-callchain](https://github.com/hunterdurbin/vscode-4d-callchain).

## Documentation

Full documentation — including the MCP server setup for AI agents and the complete lint-rule
reference — lives in the [GitHub repository](https://github.com/hunterdurbin/vscode-4d-callchain#readme).

## License

[MIT](LICENSE)
