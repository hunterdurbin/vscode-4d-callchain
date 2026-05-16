#!/usr/bin/env node
// Smoke test for the seven new IDE LSP features:
//   foldingRange, selectionRange, documentHighlight, semantic tokens,
//   diagnostics (push), signatureHelp, completion ($var.)
// Spawns language-server + ide-server and probes a small set of known files.
// Usage: node scripts/ide-features-smoke.js [projectRoot]

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const projectRoot = process.argv[2] || "/Users/hunterdurbin/src/4d/symphony";
const rootUri = "file://" + projectRoot;

function makeServer(distRelative) {
  const srv = spawn("node", [path.join(__dirname, "..", distRelative), "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  const pending = new Map();
  const subscriptions = [];
  function send(message) {
    const body = JSON.stringify(message);
    srv.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n` + body);
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
  function subscribe(method, fn) {
    subscriptions.push({ method, fn });
  }
  srv.stdout.on("data", (chunk) => {
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
      try { msg = JSON.parse(body); } catch { continue; }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        msg.error ? p.reject(msg.error) : p.resolve(msg.result);
      } else if (msg.method) {
        for (const s of subscriptions) if (s.method === msg.method) s.fn(msg.params);
      }
    }
  });
  return { request, notify, subscribe, kill: () => srv.kill() };
}

const TARGET_FILE = "Project/Sources/Classes/ConfigRepo.4dm";

(async () => {
  const lang = makeServer("packages/server/dist/bin.js");
  const ide  = makeServer("packages/ide-server/dist/bin.js");

  for (const s of [lang, ide]) {
    await s.request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "symphony" }],
      capabilities: {}
    });
    s.notify("initialized", {});
  }

  // Wait for the language server to load the cached index.
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const out = await lang.request("workspace/symbol", { query: "ConfigRepo" });
      if (out && out.length > 0) ready = true;
    } catch {}
  }
  if (!ready) { console.error("✗ index never loaded"); lang.kill(); ide.kill(); process.exit(1); }

  const fileAbs = path.join(projectRoot, TARGET_FILE);
  const fileUri = "file://" + fileAbs;
  const text = fs.readFileSync(fileAbs, "utf8");

  // Diagnostics arrive as notifications — subscribe before didOpen.
  const diagsSeen = new Map();
  lang.subscribe("textDocument/publishDiagnostics", (p) => {
    diagsSeen.set(p.uri, p.diagnostics);
  });

  for (const s of [lang, ide]) {
    s.notify("textDocument/didOpen", {
      textDocument: { uri: fileUri, languageId: "4d", version: 1, text }
    });
  }

  const folds = await lang.request("textDocument/foldingRange", {
    textDocument: { uri: fileUri }
  });
  console.log(`folding: ${(folds ?? []).length} ranges`);
  if (folds && folds.length) console.log("  first:", JSON.stringify(folds[0]));

  const sel = await lang.request("textDocument/selectionRange", {
    textDocument: { uri: fileUri },
    positions: [{ line: 10, character: 5 }]
  });
  let depth = 0;
  let node = sel?.[0];
  while (node) { depth++; node = node.parent; }
  console.log(`selectionRange[0] depth: ${depth}`);

  const sem = await lang.request("textDocument/semanticTokens/full", {
    textDocument: { uri: fileUri }
  });
  console.log(`semanticTokens: ${(sem?.data?.length ?? 0) / 5} tokens`);

  // documentHighlight on the file's class name (the file declares ConfigRepo)
  // — picking a known identifier position is fragile across edits. Use a
  // bounded probe: try a few positions and report whichever finds matches.
  let highlights;
  for (let line = 0; line < Math.min(60, text.split("\n").length); line++) {
    highlights = await lang.request("textDocument/documentHighlight", {
      textDocument: { uri: fileUri },
      position: { line, character: 4 }
    });
    if (highlights && highlights.length > 0) {
      console.log(`documentHighlight (line ${line}): ${highlights.length} matches`);
      break;
    }
  }
  if (!highlights || highlights.length === 0) console.log("documentHighlight: 0 matches");

  // signatureHelp — synthesize a scratch document containing a call to a
  // known project method (4DRequestLog_Parse — verified to have params).
  const sigScratchUri = "file:///tmp/_4dsighelp.4dm";
  const sigScratch = "Foo:=4DRequestLog_Parse(";
  ide.notify("textDocument/didOpen", {
    textDocument: { uri: sigScratchUri, languageId: "4d", version: 1, text: sigScratch }
  });
  const sig = await ide.request("textDocument/signatureHelp", {
    textDocument: { uri: sigScratchUri },
    position: { line: 0, character: sigScratch.length },
    context: { triggerKind: 2, isRetrigger: false }
  });
  console.log(`signatureHelp: ${sig ? `→ '${sig.signatures?.[0]?.label}' active=${sig.activeParameter}` : "null"}`);

  // Completion: probe a $var. completion against a synthesized var/. We
  // craft a tiny scratch document with a known declared type.
  const scratchUri = "file:///tmp/_4dvarcomplete.4dm";
  const scratch = [
    "Function probe",
    "  var $col : Collection",
    "  $col."
  ].join("\n");
  ide.notify("textDocument/didOpen", {
    textDocument: { uri: scratchUri, languageId: "4d", version: 1, text: scratch }
  });
  const comp = await ide.request("textDocument/completion", {
    textDocument: { uri: scratchUri },
    position: { line: 2, character: 7 }
  });
  const items = Array.isArray(comp) ? comp : comp?.items ?? [];
  console.log(`$var. completion (Collection): ${items.length} items`);
  if (items.length) console.log("  first 5:", items.slice(0, 5).map((i) => i.label).join(", "));

  // Give diagnostics a moment to publish (didOpen triggers).
  await new Promise((r) => setTimeout(r, 1500));
  const diags = diagsSeen.get(fileUri) ?? [];
  console.log(`diagnostics: ${diags.length} for ${path.basename(fileAbs)}`);
  if (diags.length) {
    console.log("  first:", JSON.stringify({ range: diags[0].range, severity: diags[0].severity, message: diags[0].message }).slice(0, 200));
  }

  // Open a file known to have unresolved edges so we exercise the diagnostic
  // path end-to-end (not just the "clean file" zero case).
  const noisyAbs = path.join(projectRoot, "Project/Sources/Methods/IntFraudScore_BuildJSON.4dm");
  if (fs.existsSync(noisyAbs)) {
    const noisyUri = "file://" + noisyAbs;
    lang.notify("textDocument/didOpen", {
      textDocument: { uri: noisyUri, languageId: "4d", version: 1, text: fs.readFileSync(noisyAbs, "utf8") }
    });
    await new Promise((r) => setTimeout(r, 1500));
    const noisyDiags = diagsSeen.get(noisyUri) ?? [];
    console.log(`diagnostics (noisy file): ${noisyDiags.length}`);
    if (noisyDiags.length) {
      console.log("  first:", JSON.stringify({ range: noisyDiags[0].range, message: noisyDiags[0].message }).slice(0, 150));
    }
  }

  await lang.request("shutdown", null); lang.notify("exit", null);
  await ide.request("shutdown", null);  ide.notify("exit", null);
  setTimeout(() => process.exit(0), 200);
})().catch((err) => {
  console.error("✗ smoke failed:", err);
  process.exit(1);
});
