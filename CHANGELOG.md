# Changelog

All notable changes to the **4D Call Chain Explorer** extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
