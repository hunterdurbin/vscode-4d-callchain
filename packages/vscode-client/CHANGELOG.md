# Changelog

## 0.3.0 — security & trust hardening

This release tightens the extension's security posture end to end. No features
were removed; everything risky is now opt-in, trust-gated, or gone.

### MCP

- **Official provider API.** The bundled MCP server can now be offered to
  VS Code's built-in MCP support (1.101+) through the official
  `McpServerDefinitionProvider` API — no agent config files involved. Strictly
  opt-in via the new `callchain.mcp.enabled` setting (default **off**); even
  when enabled, VS Code asks before starting the server. On hosts without the
  API (Cursor, older VS Code) this is a silent no-op.
- **Server bundled in the .vsix** at `dist/mcp/bin.js`, so both the provider
  and the `Copy MCP server config` clipboard command work out of the box.
  `callchain.mcp.binPath` is now just an override.
- The clipboard command is unchanged: it never writes agent config files.

### Workspace Trust

- Declared `"limited"` untrusted-workspace support. In untrusted workspaces
  the read-only features (indexing, trees, trace, lenses, coverage) keep
  working; the test runner, the optional language server, and the MCP provider
  are disabled until the workspace is trusted.
- Settings that influence process execution or path resolution
  (`callchain.tests.command`, `callchain.tests.jsonResultsPath`,
  `callchain.index.projectRoot`, `callchain.index.builtinConstantsPaths`,
  `callchain.mcp.binPath`) are restricted: workspace-level values are ignored
  until trusted.
- Declared `virtualWorkspaces: false` (the indexer needs a real filesystem).

### No more shelling out for archives

- `.4DZ` component archives are now read in-process with a pure-JS unzip
  (fflate) instead of spawning the system `unzip`. The only process the
  extension can still spawn is your own `callchain.tests.command` — opt-in,
  trusted workspaces only, echoed verbatim before it runs — plus the optional
  language server.

### Transparency

- The shipped bundles are no longer minified, so the `.vsix` contents can be
  diffed directly against the source repository (the package grows from
  ~495 KB to ~750 KB, including the newly bundled MCP server).
- Security & privacy documentation expanded in both READMEs.
