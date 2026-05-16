import { afterAll, beforeAll, expect, it } from "vitest";
import { describeWithFixture } from "../helpers/fixture";
import { initialize, spawnLanguageServer, type LspClient } from "../helpers/lspClient";

describeWithFixture("lsp/initialize — language-server", (root) => {
  let client: LspClient;
  let init: any;

  beforeAll(async () => {
    client = spawnLanguageServer();
    const rootUri = "file://" + root;
    init = await client.request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "fixture" }],
      capabilities: {}
    });
    client.notify("initialized", {});
  });

  afterAll(async () => {
    if (client) await client.shutdown();
  });

  it("returns server capabilities", () => {
    expect(init).toBeTruthy();
    expect(init.capabilities).toBeTypeOf("object");
    const keys = Object.keys(init.capabilities);
    expect(keys.length).toBeGreaterThan(0);
  });

  it("advertises call hierarchy support", () => {
    expect(init.capabilities.callHierarchyProvider).toBeTruthy();
  });
});
