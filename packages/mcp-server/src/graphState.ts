import * as fs from "fs";
import * as path from "path";
import { CallGraph, Indexer, consoleLogger } from "@4d/core";
import { ServerOptions } from "./server.js";

/**
 * Owns the indexer + current call graph for the MCP server.
 *
 * On start it constructs an {@link Indexer} and calls `load()`, which reuses
 * the shared msgpack cache the VS Code extension / LSP servers already write
 * (near-instant, no re-index) and only falls back to a cold rebuild when no
 * fresh cache exists. It then watches the cache directory and reloads the
 * graph whenever the cache file is rewritten, so agent queries reflect the
 * latest saved state without this process doing its own incremental indexing.
 */
export class GraphState {
  private readonly indexer: Indexer;
  private readonly cachePath: string;
  private graph: CallGraph | undefined;
  private watcher: fs.FSWatcher | undefined;
  private reloadTimer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: ServerOptions) {
    this.indexer = new Indexer({
      projectRoot: opts.projectRoot,
      exclusions: [],
      cacheDir: opts.cacheDir,
      logger: consoleLogger // routes to stderr — stdout is the MCP transport
    });
    this.cachePath = this.indexer.getCachePath();
  }

  /** Load the graph once and begin watching the cache for updates. */
  async init(): Promise<void> {
    this.graph = await this.indexer.load();
    this.startWatching();
  }

  /** The current call graph. Throws if accessed before {@link init}. */
  getGraph(): CallGraph {
    if (!this.graph) throw new Error("Graph not loaded yet");
    return this.graph;
  }

  /** The 4D project root this server is indexing. */
  get projectRoot(): string {
    return this.opts.projectRoot;
  }

  /** Force a full re-index (mirrors the LSP `$/callchain/reindex`). */
  async reindex(): Promise<void> {
    this.graph = await this.indexer.rebuild();
  }

  dispose(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.watcher?.close();
  }

  /**
   * Watch the cache directory (not the file directly) so we still catch the
   * file being created later and survive editors that replace it. Debounced
   * because a single persist can emit several change events.
   */
  private startWatching(): void {
    const dir = path.dirname(this.cachePath);
    const target = path.basename(this.cachePath);
    if (!fs.existsSync(dir)) return;
    try {
      this.watcher = fs.watch(dir, (_event, filename) => {
        if (filename && path.basename(filename.toString()) !== target) return;
        this.scheduleReload();
      });
    } catch (err) {
      consoleLogger.warn(`[4d-callchain-mcp] cache watch failed: ${err}`);
    }
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      void this.reload();
    }, 300);
  }

  private async reload(): Promise<void> {
    try {
      // load() re-reads the cache from disk every call, so this picks up the
      // extension's latest write (or rebuilds if the cache went stale).
      this.graph = await this.indexer.load();
      consoleLogger.info(`[4d-callchain-mcp] reloaded graph (${this.graph.allSymbols().length} symbols)`);
    } catch (err) {
      consoleLogger.warn(`[4d-callchain-mcp] reload failed: ${err}`);
    }
  }
}
