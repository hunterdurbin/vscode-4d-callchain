import * as vscode from "vscode";

/**
 * Typed accessors for every `callchain.*` setting the client reads.
 *
 * One module owns the key strings so the package.json `configuration`
 * contribution and the read sites can't drift apart silently — a grep for
 * `"callchain.` outside this file (and the codeLens block, whose eight keys
 * live with the lens provider) should come up empty in src/.
 *
 * Reads are intentionally NOT cached here: each accessor asks VS Code for the
 * current value, so command callbacks always see fresh settings. Hot paths
 * that can't afford a read per call (the lens provider) cache locally and
 * refresh on their own config-change listener.
 */
const SECTION = "callchain";

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

// ── Indexing ────────────────────────────────────────────────────────────────

export function projectRootSetting(): string {
  return cfg().get<string>("index.projectRoot", "");
}

export function indexExclusions(): string[] {
  return cfg().get<string[]>("index.exclusions", ["DerivedData", "Libraries", ".git", "node_modules"]);
}

export function builtinConstantsPaths(): string[] {
  return cfg().get<string[]>("index.builtinConstantsPaths", []);
}

export function autoIndexOnStartup(): boolean {
  return cfg().get<boolean>("index.autoOnStartup", true);
}

// ── Language server ─────────────────────────────────────────────────────────

export function serverEnabled(): boolean {
  return cfg().get<boolean>("server.enabled", false);
}

// ── Views & graph ───────────────────────────────────────────────────────────

export function showCallSiteSnippets(): boolean {
  return cfg().get<boolean>("views.showCallSiteSnippets", true);
}

export function traceHiddenKinds(): string[] {
  return cfg().get<string[]>("trace.hiddenKinds", ["builtins", "constants", "variables"]);
}

// ── Coverage ────────────────────────────────────────────────────────────────

export function showCoverageHints(): boolean {
  return cfg().get<boolean>("coverage.showHints", false);
}

export function coveragePatternSetting(key: "testFunctionPattern" | "testClassPattern" | "testMethodPattern"): string {
  return cfg().get<string>(`coverage.${key}`, "");
}

// ── Tests ───────────────────────────────────────────────────────────────────

export function testsEnabled(): boolean {
  return cfg().get<boolean>("tests.enabled", false);
}

export function testCommand(): string {
  return cfg().get<string>("tests.command", "make test class={class} format=json outputPath={jsonOutputPath}");
}

export function jsonResultsPath(): string {
  return cfg().get<string>("tests.jsonResultsPath", "Components/testing.4dbase/test-results/results.json");
}

// ── MCP ─────────────────────────────────────────────────────────────────────

export function mcpBinPath(): string {
  return cfg().get<string>("mcp.binPath", "");
}

// ── Config-change helpers ───────────────────────────────────────────────────

/** True when the event touches any of the given `callchain.` sub-keys. */
export function affectsAny(e: vscode.ConfigurationChangeEvent, ...keys: string[]): boolean {
  return keys.some((k) => e.affectsConfiguration(`${SECTION}.${k}`));
}
