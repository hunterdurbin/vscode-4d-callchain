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

describeWithFixture("ide/folding — foldingRange + selectionRange", (root) => {
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

  it("foldingRange returns ≥1 range and each range has start/end lines", async () => {
    if (!fs.existsSync(fileAbs)) return;
    const folds = await lang.request<any[]>("textDocument/foldingRange", {
      textDocument: { uri: fileUri }
    });
    expect(Array.isArray(folds)).toBe(true);
    expect(folds.length).toBeGreaterThanOrEqual(1);
    for (const f of folds) {
      expect(typeof f.startLine).toBe("number");
      expect(typeof f.endLine).toBe("number");
      expect(f.endLine).toBeGreaterThanOrEqual(f.startLine);
    }
  });

  it("selectionRange returns a non-trivial parent chain at a code position", async () => {
    if (!fs.existsSync(fileAbs)) return;
    const sel = await lang.request<any[]>("textDocument/selectionRange", {
      textDocument: { uri: fileUri },
      positions: [{ line: 10, character: 5 }]
    });
    expect(Array.isArray(sel)).toBe(true);
    expect(sel.length).toBeGreaterThanOrEqual(1);
    let depth = 0;
    let node: any = sel[0];
    while (node) {
      depth++;
      node = node.parent;
    }
    expect(depth).toBeGreaterThanOrEqual(2);
  });
});
