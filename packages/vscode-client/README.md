# 4D Call Chain Explorer

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/hunterdurbin.vscode-4d-callchain?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=hunterdurbin.vscode-4d-callchain)
[![Open VSX](https://img.shields.io/open-vsx/v/hunterdurbin/vscode-4d-callchain?label=Open%20VSX)](https://open-vsx.org/extension/hunterdurbin/vscode-4d-callchain)

Navigate call chains in [4D](https://us.4d.com/) v21 projects — methods, class functions, and plugins — right inside VS Code.

## Features

- **Callers** and **Callees** trees in the activity bar (update as you move the cursor)
- **Graph view** rendered with Cytoscape.js — depth slider, direction toggle, color-coded by symbol kind
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

## Requirements

The default build depends on [`4D.4d-analyzer`](https://marketplace.visualstudio.com/items?itemName=4D.4d-analyzer)
for 4D syntax highlighting and installs it automatically.

## Settings

- `callchain.projectRoot` — path to the 4D project root (the folder containing `Project/`). Defaults to the first workspace folder.
- `callchain.testCommand` — test command template (default: `make test class={class} format=junit`).
- `callchain.junitResultsPath` — relative path to JUnit XML output.
- `callchain.maxGraphDepth` — default graph BFS depth.
- `callchain.showCoverageHints` — gutter markers for uncovered functions.
- `callchain.lint.rules` — per-rule severity + options for the built-in linter (all off by default).

## Documentation

Full documentation — including the MCP server setup for AI agents and the complete lint-rule
reference — lives in the [GitHub repository](https://github.com/hunterdurbin/vscode-4d-callchain#readme).

## License

[MIT](LICENSE)
