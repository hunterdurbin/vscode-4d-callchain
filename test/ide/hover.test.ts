import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeWithFixture } from "../helpers/fixture";
import {
  initialize,
  spawnIdeServer,
  waitForIdeReady,
  type LspClient
} from "../helpers/lspClient";

describeWithFixture("ide/hover — ConfigRepo.4dm", (root) => {
  let client: LspClient;
  const fileAbs = path.join(root, "Project/Sources/Classes/ConfigRepo.4dm");
  const fileUri = "file://" + fileAbs;
  let text: string;

  beforeAll(async () => {
    client = spawnIdeServer();
    await initialize(client, root);
    await waitForIdeReady(client);
    if (!fs.existsSync(fileAbs)) return;
    text = fs.readFileSync(fileAbs, "utf8");
    client.notify("textDocument/didOpen", {
      textDocument: { uri: fileUri, languageId: "4d", version: 1, text }
    });
  });

  afterAll(async () => {
    if (client) await client.shutdown();
  });

  it("hover on `Function getConfig` returns content", async () => {
    if (!fs.existsSync(fileAbs)) return;
    const lines = text.split(/\r?\n/);
    const lineIdx = lines.findIndex((l) => /^\s*Function\s+getConfig\b/.test(l));
    expect(lineIdx).toBeGreaterThanOrEqual(0);
    const ch = lines[lineIdx].indexOf("getConfig") + 3;

    // Hover may need a tick after didOpen — poll briefly.
    let hover: any = null;
    for (let i = 0; i < 30 && (!hover || !hover.contents); i++) {
      hover = await client.request("textDocument/hover", {
        textDocument: { uri: fileUri },
        position: { line: lineIdx, character: ch }
      });
      if (hover && hover.contents) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(hover).toBeTruthy();
    expect(hover.contents).toBeTruthy();
    const body =
      typeof hover.contents === "string"
        ? hover.contents
        : hover.contents.value ?? hover.contents.kind;
    expect(body.length).toBeGreaterThan(0);
  });
});
