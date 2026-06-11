import * as vscode from "vscode";
import { Indexer } from "@4d/core";
import { debounce } from "../util/debounce";

export interface IndexerServiceOptions {
  projectRoot: string;
  exclusions: string[];
  builtinConstantsPaths: string[];
  output: vscode.OutputChannel;
  /** Whether the language-server process is also running (see persist note). */
  serverEnabled: boolean;
}

/** Construct the in-process indexer wired to the extension's output channel. */
export function createIndexer(opts: IndexerServiceOptions): Indexer {
  return new Indexer({
    projectRoot: opts.projectRoot,
    exclusions: opts.exclusions,
    builtinConstantsPaths: opts.builtinConstantsPaths,
    // The msgpack encode of a multi-MB index is synchronous CPU on the
    // extension host — the thread every extension's save participants share.
    // When the language server is running, IT becomes the sole cache writer
    // (a few hundred ms of encode in its own process is harmless) and this
    // indexer never encodes at all. Solo, writes stay on, pushed out to a
    // 5s trailing debounce so a save/format burst encodes once at idle
    // (deactivate() flushes the pending write).
    persistMode: opts.serverEnabled ? "off" : "debounced",
    persistDebounceMs: 5000,
    logger: {
      info: (m) => opts.output.appendLine(m),
      warn: (m) => opts.output.appendLine(m),
      error: (m) => opts.output.appendLine(m)
    }
  });
}

/**
 * File-system watchers — `.4dm` flows through the surgical patch path;
 * catalog / constants / components events trigger a full rebuild via the
 * indexer's classifier. Separate watchers per category keep the LSP
 * synchronize handler symmetric and let each category be tuned later
 * (e.g. component archive debounce) without affecting the others.
 *
 * All four watchers feed one debounced batching queue. Git operations driven
 * by other extensions (branch switch, fetch, stash, GitLens compare) touch or
 * rewrite the mtimes of hundreds of files at once; firing a separate
 * `patchFile` per event ran a re-parse + full view/coverage/lens refresh on
 * the single-threaded extension host for each one, hanging the UI. Coalescing
 * collapses a burst into one `patchFiles` call so the graph and views refresh
 * once — and lets the indexer's >50-change bail-to-rebuild path engage.
 */
export function registerIndexWatchers(
  context: vscode.ExtensionContext,
  projectRoot: string,
  indexer: Indexer
): void {
  const pending = new Map<string, "change" | "delete" | "create">();
  const flushPending = debounce(() => {
    if (pending.size === 0) return;
    const batch = [...pending.entries()].map(([path, kind]) => ({ path, kind }));
    pending.clear();
    void indexer.patchFiles(batch);
  }, 250); // matches the indexer's persistDebounceMs cadence
  // Last write wins per path within a burst (a create+change collapses to the
  // latest; a trailing delete supersedes earlier changes).
  const enqueue = (uri: vscode.Uri, kind: "change" | "delete" | "create") => {
    pending.set(uri.fsPath, kind);
    flushPending();
  };

  const globs = [
    "Project/Sources/**/*.4dm",
    "Project/Sources/catalog.4DCatalog",
    "Resources/Constants_*.xlf",
    "Components/**/*.{4DZ,4dz}"
  ];
  for (const glob of globs) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(projectRoot, glob)
    );
    watcher.onDidChange((uri) => enqueue(uri, "change"));
    watcher.onDidCreate((uri) => enqueue(uri, "create"));
    watcher.onDidDelete((uri) => enqueue(uri, "delete"));
    context.subscriptions.push(watcher);
  }
}
