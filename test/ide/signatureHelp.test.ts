import { afterAll, beforeAll, expect, it } from "vitest";
import { describeWithFixture } from "../helpers/fixture";
import {
  initialize,
  spawnLanguageServer,
  waitForIndex,
  type LspClient
} from "../helpers/lspClient";

describeWithFixture("ide/signatureHelp — scratch document", (root) => {
  let ide: LspClient;
  const scratchUri = "file:///tmp/_4d_sighelp.4dm";
  const scratchText = "Foo:=4DRequestLog_Parse(";

  beforeAll(async () => {
    ide = spawnLanguageServer();
    await initialize(ide, root);
    await waitForIndex(ide, "ConfigRepo");
    ide.notify("textDocument/didOpen", {
      textDocument: { uri: scratchUri, languageId: "4d", version: 1, text: scratchText }
    });
  });

  afterAll(async () => {
    if (ide) await ide.shutdown();
  });

  it("returns a signature with the method label and an active parameter", async () => {
    const sig = await ide.request<any>("textDocument/signatureHelp", {
      textDocument: { uri: scratchUri },
      position: { line: 0, character: scratchText.length },
      context: { triggerKind: 2, isRetrigger: false }
    });
    expect(sig).toBeTruthy();
    expect(Array.isArray(sig.signatures)).toBe(true);
    expect(sig.signatures.length).toBeGreaterThanOrEqual(1);
    expect(typeof sig.signatures[0].label).toBe("string");
    // After the opening paren, activeParameter should be 0 (first arg).
    expect(sig.activeParameter).toBe(0);
  });
});
