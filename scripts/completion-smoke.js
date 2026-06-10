#!/usr/bin/env node
// Smoke-test completion against a real 4D file in a 4D project.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const projectRoot = process.argv[2] || "/path/to/4d-project";
const rootUri = "file://" + projectRoot;
const server = spawn("node", [path.join(__dirname, "..", "packages", "ide-server", "dist", "bin.js"), "--stdio"], {
  stdio: ["pipe", "pipe", "inherit"]
});

let buffer = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();
function send(message) {
  const body = JSON.stringify(message);
  server.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n` + body);
}
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}
function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}
server.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const m = buffer.slice(0, headerEnd).toString("utf8").match(/Content-Length: (\d+)/i);
    if (!m) { buffer = buffer.slice(headerEnd + 4); continue; }
    const len = parseInt(m[1], 10);
    if (buffer.length < headerEnd + 4 + len) return;
    const body = buffer.slice(headerEnd + 4, headerEnd + 4 + len).toString("utf8");
    buffer = buffer.slice(headerEnd + 4 + len);
    let msg; try { msg = JSON.parse(body); } catch { continue; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      msg.error ? p.reject(msg.error) : p.resolve(msg.result);
    } else if (msg.method === "window/logMessage") {
      console.log(`[server] ${msg.params.message}`);
    }
  }
});

(async () => {
  await request("initialize", {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: "project" }],
    capabilities: {}
  });
  notify("initialized", {});

  // Open ConfigRepo.4dm — has `var $result : cs.Result` and chain usage.
  const fileAbs = `${projectRoot}/Project/Sources/Classes/ConfigRepo.4dm`;
  const fileUri = `file://${fileAbs}`;
  const orig = fs.readFileSync(fileAbs, "utf8");
  notify("textDocument/didOpen", {
    textDocument: { uri: fileUri, languageId: "4d", version: 1, text: orig }
  });

  // Wait for the index to load (poll a hover until it returns something).
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const h = await request("textDocument/hover", { textDocument: { uri: fileUri }, position: { line: 0, character: 0 } });
      // Hover may return null when not on an identifier — what matters is we got a response.
      if (h !== undefined) break;
    } catch {}
  }

  // Probe 1: free completion. Type "Cred" somewhere — simulate by sending a
  // didChange that inserts "Cred" at end of file, then complete at that pos.
  const lines = orig.split(/\r?\n/);
  const probeLine = lines.length;
  const newText = orig + "\nCred";
  notify("textDocument/didChange", {
    textDocument: { uri: fileUri, version: 2 },
    contentChanges: [{ text: newText }]
  });
  let res = await request("textDocument/completion", {
    textDocument: { uri: fileUri },
    position: { line: probeLine, character: 4 }
  });
  const items1 = Array.isArray(res) ? res : res?.items ?? [];
  console.log(`Probe 1 [free "Cred"]: ${items1.length} items`);
  console.log("  first 5:", items1.slice(0, 5).map((i) => i.label).join(", "));

  // Probe 2: cs.Result. → project class members.
  const newText2 = orig + "\ncs.Result.";
  notify("textDocument/didChange", {
    textDocument: { uri: fileUri, version: 3 },
    contentChanges: [{ text: newText2 }]
  });
  res = await request("textDocument/completion", {
    textDocument: { uri: fileUri },
    position: { line: probeLine, character: 10 }
  });
  const items2 = Array.isArray(res) ? res : res?.items ?? [];
  console.log(`Probe 2 [cs.Result.]: ${items2.length} items`);
  console.log("  first 5:", items2.slice(0, 5).map((i) => `${i.label} (${i.detail ?? "?"})`).join(", "));

  // Probe 3: cs.Testing.Testing. → component class members.
  const newText3 = orig + "\ncs.Testing.Testing.";
  notify("textDocument/didChange", {
    textDocument: { uri: fileUri, version: 4 },
    contentChanges: [{ text: newText3 }]
  });
  res = await request("textDocument/completion", {
    textDocument: { uri: fileUri },
    position: { line: probeLine, character: 19 }
  });
  const items3 = Array.isArray(res) ? res : res?.items ?? [];
  console.log(`Probe 3 [cs.Testing.Testing.]: ${items3.length} items`);
  console.log("  first 5:", items3.slice(0, 5).map((i) => i.label).join(", "));

  // Probe 4: This. inside ConfigRepo class.
  const newText4 = orig + "\nThis.";
  notify("textDocument/didChange", {
    textDocument: { uri: fileUri, version: 5 },
    contentChanges: [{ text: newText4 }]
  });
  res = await request("textDocument/completion", {
    textDocument: { uri: fileUri },
    position: { line: probeLine, character: 5 }
  });
  const items4 = Array.isArray(res) ? res : res?.items ?? [];
  console.log(`Probe 4 [This. inside ConfigRepo]: ${items4.length} items`);
  console.log("  first 5:", items4.slice(0, 5).map((i) => `${i.label} (${i.kind})`).join(", "));

  await request("shutdown", null);
  notify("exit", null);
  setTimeout(() => process.exit(0), 200);
})().catch((err) => {
  console.error("✗ failed:", err);
  server.kill();
  process.exit(1);
});
