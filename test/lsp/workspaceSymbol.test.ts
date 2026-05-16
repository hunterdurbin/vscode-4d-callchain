import { afterAll, beforeAll, expect, it } from "vitest";
import { describeWithFixture } from "../helpers/fixture";
import {
  initialize,
  spawnLanguageServer,
  waitForIndex,
  type LspClient
} from "../helpers/lspClient";

describeWithFixture("lsp/workspace/symbol", (root) => {
  let client: LspClient;

  beforeAll(async () => {
    client = spawnLanguageServer();
    await initialize(client, root);
    await waitForIndex(client, "CreditCard_ExpDateFromMMandYY");
  });

  afterAll(async () => {
    if (client) await client.shutdown();
  });

  it("returns ≥1 match for a known project method", async () => {
    const syms = await client.request<any[]>("workspace/symbol", {
      query: "CreditCard_ExpDateFromMMandYY"
    });
    expect(Array.isArray(syms)).toBe(true);
    expect(syms.length).toBeGreaterThanOrEqual(1);
    expect(syms[0]).toHaveProperty("name");
    expect(syms[0]).toHaveProperty("location");
  });

  it("returns an empty array for a nonsense query", async () => {
    const syms = await client.request<any[]>("workspace/symbol", {
      query: "ZZZ_definitely_not_a_real_symbol_xyz"
    });
    expect(Array.isArray(syms)).toBe(true);
    expect(syms.length).toBe(0);
  });
});
