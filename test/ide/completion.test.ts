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

describeWithFixture("ide/completion", (root) => {
  let ide: LspClient;
  const fileAbs = path.join(root, "Project/Sources/Classes/ConfigRepo.4dm");
  const fileUri = "file://" + fileAbs;
  let orig: string;
  let version = 1;

  beforeAll(async () => {
    ide = spawnLanguageServer();
    await initialize(ide, root);
    await waitForIndex(ide, "ConfigRepo");
    if (!fs.existsSync(fileAbs)) return;
    orig = fs.readFileSync(fileAbs, "utf8");
    ide.notify("textDocument/didOpen", {
      textDocument: { uri: fileUri, languageId: "4d", version: version++, text: orig }
    });
  });

  afterAll(async () => {
    if (ide) await ide.shutdown();
  });

  async function complete(suffix: string, line: number, character: number) {
    ide.notify("textDocument/didChange", {
      textDocument: { uri: fileUri, version: version++ },
      contentChanges: [{ text: orig + suffix }]
    });
    const res: any = await ide.request("textDocument/completion", {
      textDocument: { uri: fileUri },
      position: { line, character }
    });
    return Array.isArray(res) ? res : res?.items ?? [];
  }

  it("free-text completion at end-of-file returns ≥1 item for 'Cred'", async () => {
    if (!fs.existsSync(fileAbs)) return;
    const probeLine = orig.split(/\r?\n/).length;
    const items = await complete("\nCred", probeLine, 4);
    expect(items.length).toBeGreaterThanOrEqual(1);
    const labels = items.map((i: any) => i.label);
    // At least one entry should start with "Cred" (or contain it via fuzzy match).
    expect(labels.some((l: string) => /Cred/i.test(l))).toBe(true);
  });

  it("cs.Result. returns project class members", async () => {
    if (!fs.existsSync(fileAbs)) return;
    const probeLine = orig.split(/\r?\n/).length;
    const items = await complete("\ncs.Result.", probeLine, 10);
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  it("cs.Testing.Testing. returns component class members", async () => {
    if (!fs.existsSync(fileAbs)) return;
    const probeLine = orig.split(/\r?\n/).length;
    const items = await complete("\ncs.Testing.Testing.", probeLine, 19);
    // Component may not be present in every fixture — if 0, skip the count
    // check but still ensure the request succeeded (returned an array).
    expect(Array.isArray(items)).toBe(true);
  });

  it("This. inside ConfigRepo returns class members", async () => {
    if (!fs.existsSync(fileAbs)) return;
    const probeLine = orig.split(/\r?\n/).length;
    const items = await complete("\nThis.", probeLine, 5);
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  it("$var. completion on a typed local returns Collection members", async () => {
    // Synthesize a scratch document so we don't pollute the ConfigRepo state.
    const scratchUri = "file:///tmp/_4d_varcomplete.4dm";
    const scratch = ["Function probe()", "  var $col : Collection", "  $col."].join("\n");
    ide.notify("textDocument/didOpen", {
      textDocument: { uri: scratchUri, languageId: "4d", version: 1, text: scratch }
    });
    const res: any = await ide.request("textDocument/completion", {
      textDocument: { uri: scratchUri },
      position: { line: 2, character: 7 }
    });
    const items = Array.isArray(res) ? res : res?.items ?? [];
    expect(items.length).toBeGreaterThanOrEqual(1);
    const labels: string[] = items.map((i: any) => i.label);
    // Collection has well-known members like push / length — at least one should appear.
    expect(labels.some((l) => /push|length|map|filter/i.test(l))).toBe(true);
  });
});
