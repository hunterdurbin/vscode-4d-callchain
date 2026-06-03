import { ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";

export type LspClient = {
  request: <T = any>(method: string, params?: any) => Promise<T>;
  notify: (method: string, params?: any) => void;
  subscribe: (method: string, fn: (params: any) => void) => void;
  /** Register a handler for server-initiated requests. The handler's
   *  return value (or resolved promise) is sent back as the response.
   *  Required for `workspace/configuration` and `client/registerCapability`
   *  flows. */
  onRequest: (method: string, fn: (params: any) => any | Promise<any>) => void;
  kill: () => void;
  shutdown: () => Promise<void>;
};

const REPO_ROOT = path.resolve(__dirname, "..", "..");

export function spawnLanguageServer(): LspClient {
  return makeServer(path.join(REPO_ROOT, "packages/server/dist/bin.js"));
}

export function spawnIdeServer(): LspClient {
  return makeServer(path.join(REPO_ROOT, "packages/ide-server/dist/bin.js"));
}

function makeServer(binPath: string): LspClient {
  const proc: ChildProcess = spawn("node", [binPath, "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  const subscriptions: { method: string; fn: (params: any) => void }[] = [];
  const requestHandlers = new Map<string, (params: any) => any | Promise<any>>();

  function send(message: any): void {
    const body = JSON.stringify(message);
    proc.stdin!.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n` + body);
  }

  function request<T = any>(method: string, params?: any): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  function notify(method: string, params?: any): void {
    send({ jsonrpc: "2.0", method, params });
  }

  function subscribe(method: string, fn: (params: any) => void): void {
    subscriptions.push({ method, fn });
  }

  function onRequest(method: string, fn: (params: any) => any | Promise<any>): void {
    requestHandlers.set(method, fn);
  }

  proc.stdout!.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const m = header.match(/Content-Length: (\d+)/i);
      if (!m) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      if (buffer.length < headerEnd + 4 + len) return;
      const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + len).toString("utf8");
      buffer = buffer.subarray(headerEnd + 4 + len);
      let msg: any;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        msg.error ? p.reject(msg.error) : p.resolve(msg.result);
      } else if (msg.method) {
        // Server-initiated requests have BOTH method and id; notifications
        // only have method. Dispatch to subscribers either way, then —
        // when an id is present — also resolve via the request handler
        // and send a response.
        for (const s of subscriptions) if (s.method === msg.method) s.fn(msg.params);
        if (msg.id !== undefined) {
          const handler = requestHandlers.get(msg.method);
          const reply = (result: any) =>
            send({ jsonrpc: "2.0", id: msg.id, result });
          if (handler) {
            try {
              const out = handler(msg.params);
              Promise.resolve(out).then(reply, (err) => {
                send({
                  jsonrpc: "2.0",
                  id: msg.id,
                  error: { code: -32603, message: String(err) }
                });
              });
            } catch (err) {
              send({
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32603, message: String(err) }
              });
            }
          } else {
            // No handler registered — respond with null so the server
            // doesn't hang waiting (matches how a minimal client would
            // behave for unsupported requests).
            reply(null);
          }
        }
      }
    }
  });

  proc.stderr!.on("data", () => {
    // Swallow stderr — server logs noise like "[server] indexing..." that
    // would otherwise pollute vitest output. Failures still surface via
    // request rejections or hang-with-timeout.
  });

  async function shutdown(): Promise<void> {
    try {
      await request("shutdown", null);
      notify("exit", null);
    } catch {
      // Server may have crashed; fall through to kill.
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          proc.kill();
        } catch {}
        resolve();
      }, 500);
      proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  return {
    request,
    notify,
    subscribe,
    onRequest,
    kill: () => proc.kill(),
    shutdown
  };
}

export async function initialize(
  client: LspClient,
  projectRoot: string,
  name = "fixture",
  capabilities: any = {}
): Promise<void> {
  const rootUri = "file://" + projectRoot;
  await client.request("initialize", {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name }],
    capabilities
  });
  client.notify("initialized", {});
}

/**
 * Poll `workspace/symbol` until it returns ≥1 result for a known query.
 * Use for the @4d/language-server (which implements workspaceSymbolProvider).
 */
export async function waitForIndex(
  client: LspClient,
  probeQuery: string,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const out: any = await client.request("workspace/symbol", { query: probeQuery });
      if (Array.isArray(out) && out.length > 0) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for index (query="${probeQuery}")`);
}

/**
 * @4d/ide-server doesn't implement workspace/symbol — poll a hover on a
 * synthesized scratch document until the server responds (matching what
 * `scripts/completion-smoke.js` does to wait for the IDE index to load).
 */
export async function waitForIdeReady(
  client: LspClient,
  timeoutMs = 60_000
): Promise<void> {
  // Open a scratch document that references a fixture-known method so the
  // poll has something to anchor on. `MyLength` is a stable mini-4d
  // ProjectMethod — once the indexer has loaded it, the hover handler
  // returns a non-null Hover. Treating null as "ready" (as the old code
  // did) is racy: hover returns null both when graph is missing AND when
  // the word doesn't match anything, so we can't distinguish.
  const scratchUri = `file:///tmp/_4d_ide_ready_${process.pid}.4dm`;
  const scratchText = "x:=MyLength(\"hi\")\n";
  client.notify("textDocument/didOpen", {
    textDocument: { uri: scratchUri, languageId: "4d", version: 1, text: scratchText }
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const out: any = await client.request("textDocument/hover", {
        textDocument: { uri: scratchUri },
        // Character 4 = 'M' of MyLength.
        position: { line: 0, character: 4 }
      });
      if (out && out.contents) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("timed out waiting for ide-server to become ready");
}
