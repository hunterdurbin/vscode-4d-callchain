# 4D Call Chain Explorer

[![Open VSX](https://img.shields.io/open-vsx/v/hunterdurbin/vscode-4d-callchain?label=Open%20VSX)](https://open-vsx.org/extension/hunterdurbin/vscode-4d-callchain)

Navigate call chains in [4D](https://us.4d.com/) v21 projects — methods, class functions, and plugins — right inside VS Code.

## Features

- **Callers** and **Callees** trees in the activity bar (update as you move the cursor)
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
- `callchain.trace.hiddenKinds` — symbol-kind categories hidden by default in the Method Trace view.
- `callchain.coverage.showHints` — gutter markers for uncovered functions.
- `callchain.lint.rules` — per-rule severity + options for the built-in linter (all off by default).

See the [full settings reference](https://github.com/hunterdurbin/vscode-4d-callchain#readme) for the complete list.

## Security & privacy

Everything runs locally; the extension makes **no network requests** and collects no telemetry.

- Parsing uses [web-tree-sitter](https://github.com/tree-sitter/tree-sitter) compiled to **WebAssembly** — no native binaries ship in the package. Compiled-component archives (`.4DZ`) are read in-process with a pure-JS unzip; the extension spawns no shell utilities.
- The only processes the extension can spawn are opt-in and trust-gated: the optional language
  server (via the standard `vscode-languageclient` IPC transport, off by default), and — only when
  you click `▶ Run` in a **trusted** workspace — **your own** `callchain.tests.command`, echoed
  verbatim to the output channel before it runs.
- **Workspace Trust** is declared with `"limited"` support: in untrusted workspaces only read-only
  parsing and views run, and the settings that influence process execution or path resolution
  (`callchain.tests.command`, `callchain.tests.jsonResultsPath`, `callchain.index.projectRoot`,
  `callchain.index.builtinConstantsPaths`, `callchain.mcp.binPath`) are ignored.
- The MCP server is **opt-in twice over**: the official `McpServerDefinitionProvider` registration
  is off until you enable `callchain.mcp.enabled`, and even then VS Code lists the server and asks
  before starting it. The extension itself never starts the server and never writes any agent
  config file — the alternative `Copy MCP server config` command only puts a ready-to-paste JSON
  snippet on your clipboard, annotated with the file it belongs in.
- The trace views are local webviews with a strict Content-Security-Policy; no remote scripts.

Source is fully open and the published package is built from it — the shipped JavaScript is
deliberately **unminified** so anyone can diff the package against the repo:
[github.com/hunterdurbin/vscode-4d-callchain](https://github.com/hunterdurbin/vscode-4d-callchain).

## Documentation

Full documentation — including the MCP server setup for AI agents and the complete lint-rule
reference — lives in the [GitHub repository](https://github.com/hunterdurbin/vscode-4d-callchain#readme).

## License

[MIT](LICENSE)
