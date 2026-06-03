# 4D Call Chain Explorer

VS Code extension for navigating call chains in 4D v21 projects.

## Features

- **Callers** and **Callees** trees in the activity bar (updates as you move the cursor)
- **Graph view** rendered with Cytoscape.js — depth slider, direction toggle, color-coded by symbol kind
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

## Settings

- `callchain.projectRoot` — path to 4D project root (the folder containing `Project/`). Defaults to first workspace folder.
- `callchain.testCommand` — command template (default: `make test class={class} format=junit`).
- `callchain.junitResultsPath` — relative path to JUnit XML output.
- `callchain.maxGraphDepth` — default graph BFS depth.
- `callchain.showCoverageHints` — gutter markers for uncovered functions.
- `callchain.lint.rules` — per-rule severity + options for the built-in linter (eleven rules across `types/`, `decl/`, `unused/`, `style/` themes; all off by default). See [docs/lint-rules.md](docs/lint-rules.md).

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
