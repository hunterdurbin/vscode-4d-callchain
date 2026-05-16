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

describeWithFixture("ide/documentHighlight", (root) => {
  let lang: LspClient;
  const fileAbs = path.join(root, "Project/Sources/Classes/ConfigRepo.4dm");
  const fileUri = "file://" + fileAbs;
  let text: string;

  beforeAll(async () => {
    lang = spawnLanguageServer();
    await initialize(lang, root);
    await waitForIndex(lang, "ConfigRepo");
    if (!fs.existsSync(fileAbs)) return;
    text = fs.readFileSync(fileAbs, "utf8");
    lang.notify("textDocument/didOpen", {
      textDocument: { uri: fileUri, languageId: "4d", version: 1, text }
    });
  });

  afterAll(async () => {
    if (lang) await lang.shutdown();
  });

  it("returns ≥1 match for some identifier position in the file", async () => {
    if (!fs.existsSync(fileAbs)) return;
    const lines = text.split(/\r?\n/);
    let highlights: any[] = [];
    outer: for (let line = 0; line < Math.min(60, lines.length); line++) {
      const lineLen = lines[line].length;
      // Sweep across the line in 4-char strides so we land on identifiers
      // regardless of indent/content.
      for (let ch = 0; ch < Math.min(50, lineLen); ch += 4) {
        highlights = (await lang.request<any[]>("textDocument/documentHighlight", {
          textDocument: { uri: fileUri },
          position: { line, character: ch }
        })) ?? [];
        if (highlights.length > 0) break outer;
      }
    }
    expect(highlights.length).toBeGreaterThanOrEqual(1);
    expect(highlights[0]).toHaveProperty("range");
  });
});
