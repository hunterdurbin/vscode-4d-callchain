import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeWithFixture } from "../helpers/fixture";
import {
  initialize,
  spawnLanguageServer,
  waitForIndex,
  type LspClient
} from "../helpers/lspClient";

describeWithFixture("ide/semanticTokens — full document", (root) => {
  let lang: LspClient;
  const fileAbs = path.join(root, "Project/Sources/Classes/ConfigRepo.4dm");
  const fileUri = "file://" + fileAbs;

  beforeAll(async () => {
    // Drop the cached index — `isFresh` only re-checks `.4dm` file mtimes,
    // so adding a Plugins/ bundle or a brand-new source file (like the
    // plugin-coloring test below relies on) doesn't invalidate it on its
    // own. Cheap on the mini fixture (~25 files); ensures the indexer
    // sees the current Plugins/ contents.
    const cache = path.join(root, ".vscode/callchain-index.json");
    if (fs.existsSync(cache)) fs.rmSync(cache);
    lang = spawnLanguageServer();
    await initialize(lang, root);
    await waitForIndex(lang, "ConfigRepo");
    if (!fs.existsSync(fileAbs)) return;
    lang.notify("textDocument/didOpen", {
      textDocument: {
        uri: fileUri,
        languageId: "4d",
        version: 1,
        text: fs.readFileSync(fileAbs, "utf8")
      }
    });
  });

  afterAll(async () => {
    if (lang) await lang.shutdown();
  });

  it("returns a packed token array with length divisible by 5", async () => {
    if (!fs.existsSync(fileAbs)) return;
    const sem = await lang.request<any>("textDocument/semanticTokens/full", {
      textDocument: { uri: fileUri }
    });
    expect(sem).toBeTruthy();
    expect(Array.isArray(sem.data)).toBe(true);
    expect(sem.data.length % 5).toBe(0);
    // ConfigRepo emits semantic tokens for keywords + identifiers — the
    // exact count varies by fixture size; ≥1 confirms the encoder runs.
    expect(sem.data.length / 5).toBeGreaterThanOrEqual(1);
  });

  // Plugin command coloring — `PgSQL Connect` should encode as
  // type=method(0), modifiers=plugin(bit 3 = 8). The fixture's
  // Plugins/PgSQL.bundle manifest contributes the command names, the
  // indexer surfaces them as PluginCommand symbols, and the
  // semantic-tokens handler feeds those names into the lexer so the
  // whole-span identifier lights up even on a paren-less call line.
  it("paints `PgSQL Connect` as method.plugin", async () => {
    const pluginCallerAbs = path.join(root, "Project/Sources/Methods/Plugin_Caller.4dm");
    const pluginCallerUri = "file://" + pluginCallerAbs;
    if (!fs.existsSync(pluginCallerAbs)) return;
    const text = fs.readFileSync(pluginCallerAbs, "utf8");
    lang.notify("textDocument/didOpen", {
      textDocument: { uri: pluginCallerUri, languageId: "4d", version: 1, text }
    });
    const sem = await lang.request<any>("textDocument/semanticTokens/full", {
      textDocument: { uri: pluginCallerUri }
    });
    expect(sem).toBeTruthy();
    const data: number[] = sem.data;
    // Decode the LSP delta-packed format and look for a token whose
    // length matches "PgSQL Connect" (13 chars) with type=method(0)
    // and modifiers having bit 3 (plugin) set.
    const MOD_PLUGIN_BIT = 1 << 3;
    let absLine = 0;
    let absCol = 0;
    let found = false;
    for (let i = 0; i < data.length; i += 5) {
      const dLine = data[i];
      const dCol = data[i + 1];
      const len = data[i + 2];
      const typ = data[i + 3];
      const mods = data[i + 4];
      absLine += dLine;
      absCol = dLine === 0 ? absCol + dCol : dCol;
      if (len === "PgSQL Connect".length && typ === 0 && (mods & MOD_PLUGIN_BIT) !== 0) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});
