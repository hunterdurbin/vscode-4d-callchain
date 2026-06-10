#!/usr/bin/env node
// LSP server smoke test: initialize + workspaceSymbol against a 4D project.
// Usage: node scripts/lsp-smoke.js [projectRoot]

const { spawn } = require("child_process");
const path = require("path");

const projectRoot = process.argv[2] || "/path/to/4d-project";
const rootUri = "file://" + projectRoot;
const server = spawn("node", [path.join(__dirname, "..", "packages", "server", "dist", "bin.js"), "--stdio"], {
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
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const m = header.match(/Content-Length: (\d+)/i);
    if (!m) { buffer = buffer.slice(headerEnd + 4); continue; }
    const len = parseInt(m[1], 10);
    if (buffer.length < headerEnd + 4 + len) return;
    const body = buffer.slice(headerEnd + 4, headerEnd + 4 + len).toString("utf8");
    buffer = buffer.slice(headerEnd + 4 + len);
    let msg;
    try { msg = JSON.parse(body); } catch (e) { console.error("[parse]", e); continue; }
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
  console.log(`Probing LSP server against ${projectRoot}`);
  const init = await request("initialize", {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: "project" }],
    capabilities: {}
  });
  console.log("✓ initialize capabilities:", Object.keys(init.capabilities).join(", "));

  notify("initialized", {});

  // Wait for indexer to load. We poll workspaceSymbol until we get a result.
  let attempts = 0;
  while (attempts < 60) {
    await new Promise((r) => setTimeout(r, 1000));
    attempts++;
    try {
      const syms = await request("workspace/symbol", { query: "CreditCard_ExpDateFromMMandYY" });
      if (syms && syms.length > 0) {
        console.log(`✓ workspaceSymbol returned ${syms.length} match(es) for CreditCard_ExpDateFromMMandYY`);
        console.log("  first:", JSON.stringify(syms[0]).slice(0, 200));
        break;
      }
    } catch (e) {
      // Server may not be ready
    }
  }
  if (attempts >= 60) {
    console.error("✗ timed out waiting for index");
    server.kill();
    process.exit(1);
  }

  // Try call hierarchy on a known symbol. Need to didOpen first since handlers
  // read the line text from the document store.
  const fs2 = require("fs");
  const fileAbs = `${projectRoot}/Project/Sources/Methods/CreditCard_ExpDateFromMMandYY.4dm`;
  const fileUri = `file://${fileAbs}`;
  const text = fs2.readFileSync(fileAbs, "utf8");
  notify("textDocument/didOpen", {
    textDocument: { uri: fileUri, languageId: "4d", version: 1, text }
  });
  // Position on the identifier in `// CreditCard_ExpDateFromMMandYY` (line 1, char 5)
  const prep = await request("textDocument/prepareCallHierarchy", {
    textDocument: { uri: fileUri },
    position: { line: 1, character: 5 }
  });
  console.log(`✓ prepareCallHierarchy returned ${(prep ?? []).length} item(s)`);

  if (prep && prep.length > 0) {
    const incoming = await request("callHierarchy/incomingCalls", { item: prep[0] });
    console.log(`✓ callHierarchy/incomingCalls returned ${(incoming ?? []).length} caller group(s)`);
  }

  await request("shutdown", null);
  notify("exit", null);
  setTimeout(() => process.exit(0), 200);
})().catch((err) => {
  console.error("✗ smoke failed:", err);
  server.kill();
  process.exit(1);
});
