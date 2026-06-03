import { afterAll, beforeAll, expect, it } from "vitest";
import { describeWithFixture } from "../helpers/fixture";
import {
  initialize,
  spawnLanguageServer,
  waitForIndex,
  type LspClient
} from "../helpers/lspClient";

/**
 * End-to-end test for the Phase B lint pipeline:
 *   - rule off by default → no lint diagnostics
 *   - enable via callchain.lint.rules + didChangeConfiguration → rule fires
 *   - inline `// lint-disable-next-line` suppression drops the matching finding
 *   - severity = "off" via didChangeConfiguration → diagnostics clear
 *   - per-rule options round-trip ({ severity, options })
 */

describeWithFixture("ide/lint-pipeline — smoke rule end-to-end", (root) => {
  let lang: LspClient;
  const diagsByUri = new Map<string, any[]>();
  const docUri = "file:///tmp/_4d_lint_smoke.4dm";

  // Six-line buffer: lines 1, 3, 5 end in trailing whitespace. Line 4 also
  // has trailing whitespace BUT is preceded by a lint-disable-next-line
  // comment on line 3 (well, the comment lives at line 3 alongside its
  // own trailing space — we account for that in the assertion).
  //
  // Layout:
  //   0: "x:=1\n"                     (clean)
  //   1: "y:=2  \n"                   (trailing — should flag)
  //   2: "// some prose\n"            (clean)
  //   3: "// lint-disable-next-line style/trailing-whitespace\n" (clean)
  //   4: "z:=3  \n"                   (trailing — suppressed by line 3)
  //   5: "w:=4\t\n"                   (trailing tab — should flag with default opts)
  const docText = [
    "x:=1",
    "y:=2  ",
    "// some prose",
    "// lint-disable-next-line style/trailing-whitespace",
    "z:=3  ",
    "w:=4\t"
  ].join("\n");

  let currentConfig: any = {};

  beforeAll(async () => {
    lang = spawnLanguageServer();
    lang.subscribe("textDocument/publishDiagnostics", (p) => {
      diagsByUri.set(p.uri, p.diagnostics);
    });
    // Server pulls the live config via workspace/configuration on demand —
    // return whatever the test has currently staged. The standard LSP shape
    // is an array (one entry per requested section).
    lang.onRequest("workspace/configuration", () => {
      return [currentConfig];
    });
    // Acknowledge the dynamic registration of didChangeConfiguration.
    lang.onRequest("client/registerCapability", () => null);

    await initialize(lang, root, "fixture", {
      workspace: { configuration: true, didChangeConfiguration: { dynamicRegistration: true } }
    });
    await waitForIndex(lang, "ConfigRepo");

    lang.notify("textDocument/didOpen", {
      textDocument: { uri: docUri, languageId: "4d", version: 1, text: docText }
    });
    // Initial publish — give the server a beat to emit.
    await waitForDiagnostic(60);
  });

  afterAll(async () => {
    if (lang) await lang.shutdown();
  });

  async function waitForDiagnostic(deciseconds: number): Promise<void> {
    for (let i = 0; i < deciseconds; i++) {
      if (diagsByUri.has(docUri)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function setRulesAndWait(rules: any): Promise<any[]> {
    currentConfig = rules;
    // Stub change notification — the server's onDidChangeConfiguration
    // handler re-fetches via workspace/configuration regardless of what we
    // send here.
    diagsByUri.delete(docUri);
    lang.notify("workspace/didChangeConfiguration", { settings: null });
    // Re-publish only happens after refreshLintConfig() completes; give it
    // up to a few seconds.
    for (let i = 0; i < 60; i++) {
      const diags = diagsByUri.get(docUri);
      if (diags) return diags;
      await new Promise((r) => setTimeout(r, 100));
    }
    return [];
  }

  it("ships off-by-default — no lint diagnostics on initial open", () => {
    const diags = diagsByUri.get(docUri) ?? [];
    // No 4d-lint diagnostics — unresolved-call may publish, but lint
    // rules should all be off.
    expect(diags.filter((d: any) => d.source === "4d-lint")).toHaveLength(0);
  });

  it("enabling style/trailing-whitespace surfaces findings (with suppression respected)", async () => {
    const diags = await setRulesAndWait({
      "style/trailing-whitespace": "warning"
    });
    const lintDiags = diags.filter((d: any) => d.source === "4d-lint");
    expect(lintDiags.length).toBeGreaterThan(0);
    // Every lint diagnostic carries our rule's id.
    for (const d of lintDiags) expect(d.code).toBe("style/trailing-whitespace");
    // Lines that should fire: 1 (spaces), 5 (tab). Line 4 is suppressed by
    // the // lint-disable-next-line on line 3.
    const lines = new Set(lintDiags.map((d: any) => d.range.start.line));
    expect(lines.has(1)).toBe(true);
    expect(lines.has(5)).toBe(true);
    expect(lines.has(4)).toBe(false);
  });

  it("respects per-rule options — { includeTabs: false } drops the line-5 tab finding", async () => {
    const diags = await setRulesAndWait({
      "style/trailing-whitespace": {
        severity: "warning",
        options: { includeTabs: false }
      }
    });
    const lintDiags = diags.filter((d: any) => d.source === "4d-lint");
    const lines = new Set(lintDiags.map((d: any) => d.range.start.line));
    expect(lines.has(1)).toBe(true);   // still a space-trailing line
    expect(lines.has(5)).toBe(false);  // tab no longer counts
  });

  it("setting severity=off clears lint diagnostics", async () => {
    const diags = await setRulesAndWait({
      "style/trailing-whitespace": "off"
    });
    expect(diags.filter((d: any) => d.source === "4d-lint")).toHaveLength(0);
  });
});
