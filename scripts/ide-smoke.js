#!/usr/bin/env node
// IDE-server smoke test: initialize + didOpen + textDocument/hover against a 4D project.
// Usage: node scripts/ide-smoke.js [projectRoot]

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
  const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
  server.stdin.write(header + body);
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
    let msg;
    try { msg = JSON.parse(body); } catch { continue; }
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
  console.log(`Probing IDE server against ${projectRoot}`);
  const init = await request("initialize", {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: "project" }],
    capabilities: {}
  });
  console.log("✓ initialize capabilities:", Object.keys(init.capabilities).join(", "));
  notify("initialized", {});

  // Wait for the indexer to be ready — poll via a no-op hover until we see a
  // graph in place. We open ConfigRepo.4dm (which uses cs.Result, cs.Config,
  // etc.) and hover on the `cs.Result` annotation line.
  const fileAbs = `${projectRoot}/Project/Sources/Classes/ConfigRepo.4dm`;
  const fileUri = `file://${fileAbs}`;
  const text = fs.readFileSync(fileAbs, "utf8");
  notify("textDocument/didOpen", {
    textDocument: { uri: fileUri, languageId: "4d", version: 1, text }
  });

  // Wait up to 60s for the index to build.
  let hover = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    // Hover on the function name in `Function getConfig($key : Text) : cs.Result`
    // Line index of that decl in ConfigRepo: hunt for it dynamically.
    const lines = text.split(/\r?\n/);
    const lineIdx = lines.findIndex((l) => /^\s*Function\s+getConfig\b/.test(l));
    if (lineIdx === -1) { console.error("Couldn't find Function getConfig line"); break; }
    const char = lines[lineIdx].indexOf("getConfig") + 3;
    try {
      hover = await request("textDocument/hover", {
        textDocument: { uri: fileUri },
        position: { line: lineIdx, character: char }
      });
    } catch (e) { /* still indexing */ }
    if (hover && hover.contents) break;
  }
  if (!hover || !hover.contents) {
    console.error("✗ hover never returned content");
    server.kill();
    process.exit(1);
  }
  console.log("✓ hover content (truncated 400 chars):");
  const body = typeof hover.contents === "string" ? hover.contents : hover.contents.value;
  console.log("---");
  console.log(body.slice(0, 400));
  console.log("---");

  await request("shutdown", null);
  notify("exit", null);
  setTimeout(() => process.exit(0), 200);
})().catch((err) => {
  console.error("✗ smoke failed:", err);
  server.kill();
  process.exit(1);
});
