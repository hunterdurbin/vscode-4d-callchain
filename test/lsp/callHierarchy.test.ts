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

describeWithFixture("lsp/callHierarchy — prepare + incomingCalls", (root) => {
  let client: LspClient;
  const fileAbs = path.join(
    root,
    "Project/Sources/Methods/CreditCard_ExpDateFromMMandYY.4dm"
  );
  const fileUri = "file://" + fileAbs;

  beforeAll(async () => {
    client = spawnLanguageServer();
    await initialize(client, root);
    await waitForIndex(client, "CreditCard_ExpDateFromMMandYY");
    if (!fs.existsSync(fileAbs)) return;
    client.notify("textDocument/didOpen", {
      textDocument: {
        uri: fileUri,
        languageId: "4d",
        version: 1,
        text: fs.readFileSync(fileAbs, "utf8")
      }
    });
  });

  afterAll(async () => {
    if (client) await client.shutdown();
  });

  it("prepareCallHierarchy returns an item on a known identifier position", async () => {
    if (!fs.existsSync(fileAbs)) return;
    // Position on the identifier in `// CreditCard_ExpDateFromMMandYY` (line 1).
    const prep = await client.request<any[]>("textDocument/prepareCallHierarchy", {
      textDocument: { uri: fileUri },
      position: { line: 1, character: 5 }
    });
    expect(Array.isArray(prep)).toBe(true);
    expect(prep.length).toBeGreaterThanOrEqual(1);
  });

  it("incomingCalls returns ≥1 caller group", async () => {
    if (!fs.existsSync(fileAbs)) return;
    const prep = await client.request<any[]>("textDocument/prepareCallHierarchy", {
      textDocument: { uri: fileUri },
      position: { line: 1, character: 5 }
    });
    if (!prep || prep.length === 0) return;
    const incoming = await client.request<any[]>("callHierarchy/incomingCalls", {
      item: prep[0]
    });
    expect(Array.isArray(incoming)).toBe(true);
    expect(incoming.length).toBeGreaterThanOrEqual(1);
  });
});
