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
});
