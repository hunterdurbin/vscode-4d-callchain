import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { INDEX_VERSION, SymbolIndex } from "../model/symbol";
import { CallGraph } from "../model/callGraph";
import { discoverCatalogTables, discoverFiles, discoverPlugins } from "./projectScanner";
import { DEFAULT_BUILTIN_CONSTANTS_PROBES, discoverBuiltinConstants, discoverConstants } from "./constantsScanner";
import { discoverVariables } from "./variableScanner";
import { parseFile } from "./fileParser";
import { buildSymbolIndex } from "./nameResolver";

export interface IndexerOptions {
  projectRoot: string;
  exclusions: string[];
  output: vscode.OutputChannel;
  /** User override(s) for the 4D built-in constants XLF path. */
  builtinConstantsPaths?: string[];
}

const INDEX_FILENAME = "callchain-index.json";

export class Indexer {
  private currentIndex: SymbolIndex | undefined;
  private graph: CallGraph | undefined;
  private readonly emitter = new vscode.EventEmitter<CallGraph>();
  readonly onDidUpdate = this.emitter.event;

  constructor(private readonly opts: IndexerOptions) {}

  getGraph(): CallGraph | undefined {
    return this.graph;
  }

  async load(): Promise<CallGraph> {
    const cachePath = this.indexPath();
    if (fs.existsSync(cachePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(cachePath, "utf8")) as SymbolIndex;
        if (raw.version === INDEX_VERSION && (await this.isFresh(raw))) {
          this.opts.output.appendLine(`[Indexer] Loaded cached index (${raw.symbols.length} symbols, ${raw.edges.length} edges)`);
          this.currentIndex = raw;
          this.graph = new CallGraph(raw);
          this.emitter.fire(this.graph);
          return this.graph;
        } else {
          this.opts.output.appendLine(`[Indexer] Cache stale or version mismatch — rebuilding`);
        }
      } catch (err) {
        this.opts.output.appendLine(`[Indexer] Cache read failed: ${err} — rebuilding`);
      }
    }
    return this.rebuild();
  }

  async rebuild(): Promise<CallGraph> {
    const start = Date.now();
    this.opts.output.appendLine(`[Indexer] Scanning ${this.opts.projectRoot}`);
    const files = discoverFiles(this.opts.projectRoot, { exclusions: this.opts.exclusions });
    this.opts.output.appendLine(`[Indexer] Discovered ${files.length} .4dm files`);

    // Discover constants first so the parser can resolve bare-identifier
    // references against the known set inline.
    const constants = discoverConstants(this.opts.projectRoot);
    this.opts.output.appendLine(`[Indexer] Discovered ${constants.length} constants`);
    const builtinProbes = [
      ...(this.opts.builtinConstantsPaths ?? []),
      ...DEFAULT_BUILTIN_CONSTANTS_PROBES
    ];
    const builtinConstants = discoverBuiltinConstants(builtinProbes);
    this.opts.output.appendLine(`[Indexer] Discovered ${builtinConstants.length} built-in constants`);
    const constantsSet = new Set<string>([
      ...constants.map((c) => c.name),
      ...builtinConstants.map((c) => c.name)
    ]);

    const parsed = [];
    const mtimes: Record<string, number> = {};
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      parsed.push(parseFile(f, this.opts.projectRoot, constantsSet));
      try {
        mtimes[f.absolutePath] = fs.statSync(f.absolutePath).mtimeMs;
      } catch {/* skip */}
      if (i % 500 === 0 && i > 0) {
        this.opts.output.appendLine(`[Indexer]   parsed ${i}/${files.length}`);
      }
    }
    const plugins = discoverPlugins(this.opts.projectRoot);
    this.opts.output.appendLine(`[Indexer] Discovered ${plugins.length} plugin bundles`);
    const catalogTables = discoverCatalogTables(this.opts.projectRoot);
    this.opts.output.appendLine(`[Indexer] Discovered ${catalogTables.size} catalog tables`);

    const variables = discoverVariables(this.opts.projectRoot);
    this.opts.output.appendLine(`[Indexer] Discovered ${variables.length} process/interprocess variables`);

    const idx = buildSymbolIndex(this.opts.projectRoot, parsed, plugins, catalogTables, constants, builtinConstants, variables);
    idx.fileMtimes = mtimes;

    this.currentIndex = idx;
    this.graph = new CallGraph(idx);

    this.persist(idx);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    this.opts.output.appendLine(
      `[Indexer] Build complete: ${idx.symbols.length} symbols, ${idx.edges.length} edges in ${elapsed}s`
    );
    this.emitter.fire(this.graph);
    return this.graph;
  }

  async patchFile(absolutePath: string): Promise<void> {
    if (!this.currentIndex) return;
    if (!absolutePath.endsWith(".4dm")) return;
    // Cheap approach: rebuild fully. Incremental update is a v2 improvement.
    this.opts.output.appendLine(`[Indexer] File changed: ${path.basename(absolutePath)} — full rebuild`);
    await this.rebuild();
  }

  private async isFresh(raw: SymbolIndex): Promise<boolean> {
    if (raw.projectRoot !== this.opts.projectRoot) return false;
    let checked = 0;
    for (const [p, mtime] of Object.entries(raw.fileMtimes)) {
      try {
        const stat = fs.statSync(p);
        if (Math.abs(stat.mtimeMs - mtime) > 1) return false;
      } catch {
        return false;
      }
      checked++;
      if (checked > 100) break; // sample-based freshness check
    }
    return true;
  }

  private indexPath(): string {
    return path.join(this.opts.projectRoot, ".vscode", INDEX_FILENAME);
  }

  private persist(idx: SymbolIndex): void {
    try {
      const dir = path.dirname(this.indexPath());
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.indexPath(), JSON.stringify(idx));
    } catch (err) {
      this.opts.output.appendLine(`[Indexer] Persist failed: ${err}`);
    }
  }
}
