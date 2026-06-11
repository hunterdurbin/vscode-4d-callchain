import * as fs from "fs";
import * as path from "path";
import { unpack } from "msgpackr";
import { CallEdge, INDEX_VERSION, SymbolIndex } from "../model/symbol";
import { CallGraph } from "../model/callGraph";
import { Logger } from "../util/logger";
import { TypedEmitter } from "../util/emitter";
import { discoverCatalogTableIdMap, discoverCatalogTables, discoverFiles, discoverPlugins } from "./projectScanner";
import { DEFAULT_BUILTIN_CONSTANTS_PROBES, discoverBuiltinConstants, discoverConstants } from "./constantsScanner";
import { discoverVariables } from "./variableScanner";
import { discoverCompilerMethodTypes, CompilerMethodTypes } from "./compilerMethodScanner";
import { discoverComponents } from "./componentScanner";
import { ParsedFile, parseFile } from "./fileParser";
import { buildResolverScratch, buildSymbolIndex, ResolverInput } from "./nameResolver";
import { classifyFile } from "./projectScanner";
import { IndexPersistence } from "./persistence";
import {
  NameKeyEntry,
  PatchState,
  addFileContribution,
  assertSynthRefcountInvariant,
  augmentVariadicParams,
  compilerMethodTypesEqual,
  nameKeysForHint,
  removeFileContribution,
  reresolveAffectedDependents
} from "./patcher";

/**
 * The category of source change for dispatch in `patchFiles`. Drives whether
 * a watcher event flows through the surgical `.4dm` patch path or kicks off
 * a full rebuild because the change touched data feeding the resolver
 * context (catalog tables, constants, components).
 */
export type ChangeCategory = "code" | "catalog" | "constants" | "components" | "unknown";

/**
 * Classify an absolute path to a watched file. The watcher globs in the
 * VSCode client should keep "unknown" rare; it's the defensive default for
 * paths that match no recognized layout (e.g. random files surfaced by a
 * broader glob upstream).
 */
export function classifyChange(absolutePath: string, projectRoot: string): ChangeCategory {
  const rel = path.relative(projectRoot, absolutePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return "unknown";
  const parts = rel.split(path.sep);
  if (parts.length < 2) return "unknown";

  if (parts[0] === "Project" && parts[1] === "Sources") {
    if (absolutePath.endsWith(".4dm")) return "code";
    if (parts.length === 3 && parts[2] === "catalog.4DCatalog") return "catalog";
    return "unknown";
  }
  if (parts[0] === "Resources" && parts.length === 2) {
    if (/^Constants_.*\.xlf$/i.test(parts[1])) return "constants";
    return "unknown";
  }
  if (parts[0] === "Components") {
    if (/\.(4dz)$/i.test(absolutePath)) return "components";
    return "unknown";
  }
  return "unknown";
}

export interface IndexerOptions {
  projectRoot: string;
  exclusions: string[];
  logger: Logger;
  /** User override(s) for the 4D built-in constants XLF path. */
  builtinConstantsPaths?: string[];
  /** Optional override for the persistence directory. Defaults to <projectRoot>/.vscode. */
  cacheDir?: string;
  /**
   * If >0, coalesce post-patch persist calls onto a debounced timer with this
   * delay. A long-lived LSP process can set this to ~250 ms so a burst of
   * saves only triggers one cache write. Tests should leave it at 0 so the
   * cache file reflects the latest state synchronously.
   */
  persistDebounceMs?: number;
}

export class Indexer {
  private currentIndex: SymbolIndex | undefined;
  private graph: CallGraph | undefined;
  private readonly emitter = new TypedEmitter<CallGraph>();
  readonly onDidUpdate = this.emitter.event;

  // Incremental-patch state (warm caches + live graph/index references).
  // Populated by rebuild(); left undefined by the cache-only load() path so
  // the first patch falls back to a full rebuild (which then populates it).
  private patch: PatchState | undefined;
  // Cached per-method parameter-type info from Compiler_*.4dm. Refreshed on
  // full rebuild only — Compiler_* edits route through `patchFile` →
  // full-rebuild bail (see patchFiles).
  private compilerMethodTypes: Map<string, CompilerMethodTypes> | undefined;
  private readonly persistence: IndexPersistence;
  // Tracks an in-progress full rebuild so concurrent patch calls (or other
  // rebuild requests) await the same work instead of starting their own.
  // Without this, the first save after `load()` triggers a rebuild AND
  // subsequent saves arriving during that rebuild each trigger another,
  // causing N concurrent ~25s rebuilds scribbling over the same state.
  private rebuildInFlight: Promise<CallGraph> | undefined;

  constructor(private readonly opts: IndexerOptions) {
    this.persistence = new IndexPersistence({
      projectRoot: opts.projectRoot,
      cacheDir: opts.cacheDir,
      persistDebounceMs: opts.persistDebounceMs,
      logger: opts.logger
    });
  }

  getGraph(): CallGraph | undefined {
    return this.graph;
  }

  /**
   * Look up the `ParsedFile` for an indexed file by absolute path. Returns
   * undefined if the file wasn't scanned (non-`.4dm`, excluded) or if the
   * indexer cold-loaded from cache without re-parsing (the warm `parsedByPath`
   * map is empty until `populateWarmCaches()` runs at the tail of `rebuild()`,
   * or until `patchFile()` re-parses it).
   *
   * Lint rules consume this to scan per-symbol localReads / localWrites /
   * localDeclMode / bodySpan without re-invoking the parser.
   */
  getParsedFile(absolutePath: string): ParsedFile | undefined {
    return this.patch?.parsedByPath.get(absolutePath);
  }

  async load(): Promise<CallGraph> {
    const cachePath = this.persistence.indexPath();
    if (fs.existsSync(cachePath)) {
      try {
        const tRead = Date.now();
        const buf = fs.readFileSync(cachePath);
        const raw = unpack(buf) as SymbolIndex;
        const readMs = Date.now() - tRead;
        if (raw.version === INDEX_VERSION && (await this.persistence.isFresh(raw))) {
          this.opts.logger.info(
            `[Indexer] Loaded cached index (${raw.symbols.length} symbols, ${raw.edges.length} edges, ${Math.round(buf.length / 1024)}KB, ${readMs}ms)`
          );
          this.currentIndex = raw;
          this.graph = new CallGraph(raw);
          this.emitter.fire(this.graph);
          return this.graph;
        } else {
          this.opts.logger.info(`[Indexer] Cache stale or version mismatch — rebuilding`);
        }
      } catch (err) {
        this.opts.logger.warn(`[Indexer] Cache read failed: ${err} — rebuilding`);
      }
    }
    return this.rebuild();
  }

  async rebuild(): Promise<CallGraph> {
    // Coalesce concurrent rebuild requests onto a single in-flight promise.
    // Any patch that bails to rebuild (cold caches, non-`.4dm` change, etc.)
    // hits this — without coalescing, each save during a long rebuild fires
    // another full rebuild.
    if (this.rebuildInFlight) return this.rebuildInFlight;
    this.rebuildInFlight = this.doRebuild().finally(() => {
      this.rebuildInFlight = undefined;
    });
    return this.rebuildInFlight;
  }

  private async doRebuild(): Promise<CallGraph> {
    const start = Date.now();
    this.opts.logger.info(`[Indexer] Scanning ${this.opts.projectRoot}`);
    const tDiscover = Date.now();
    const files = discoverFiles(this.opts.projectRoot, { exclusions: this.opts.exclusions });
    this.opts.logger.info(`[Indexer] Discovered ${files.length} .4dm files`);

    // Discover constants + variables first so the parser can resolve
    // bare-identifier references against the known sets inline.
    const constants = discoverConstants(this.opts.projectRoot);
    this.opts.logger.info(`[Indexer] Discovered ${constants.length} constants`);
    const builtinProbes = [
      ...(this.opts.builtinConstantsPaths ?? []),
      ...DEFAULT_BUILTIN_CONSTANTS_PROBES
    ];
    const builtinConstants = discoverBuiltinConstants(builtinProbes);
    this.opts.logger.info(`[Indexer] Discovered ${builtinConstants.length} built-in constants`);
    const variables = discoverVariables(this.opts.projectRoot);
    this.opts.logger.info(`[Indexer] Discovered ${variables.length} process/interprocess variables`);
    const discoverMs = Date.now() - tDiscover;
    // Bare-identifier lookup set: constants + process variables. Interprocess
    // variables are matched via the `<>name` regex, not the bare path. 4D is
    // case-insensitive for identifiers so the set holds lowercase entries and
    // callExtractor compares against `candidate.toLowerCase()`.
    const constantsSet = new Set<string>([
      ...constants.map((c) => c.name.toLowerCase()),
      ...builtinConstants.map((c) => c.name.toLowerCase()),
      ...variables.filter((v) => v.scope === "process").map((v) => v.name.toLowerCase())
    ]);

    // Compiler_*.4dm parameter-type declarations for project methods. The
    // augmentation pass below uses this to materialize variadic params
    // (e.g. `C_LONGINT(Math_Minimum; ${1})` → `params[0] = {…, variadic: true}`).
    const compilerMethodTypes = discoverCompilerMethodTypes(this.opts.projectRoot);
    this.compilerMethodTypes = compilerMethodTypes;
    if (compilerMethodTypes.size > 0) {
      this.opts.logger.info(
        `[Indexer] Discovered ${compilerMethodTypes.size} method-type declarations from Compiler_*.4dm`,
      );
    }

    const tParse = Date.now();
    const parsed = [];
    // `isFresh` only inspects the first ~100 entries of `fileMtimes` (see
    // `isFresh` for the sample cap), so capturing an mtime per file
    // (25k statSync calls on a large project) is wasted I/O in the parse loop.
    // Sample at a stride that yields ~100 entries; the patch path still
    // adds/removes single-file entries on `change`/`delete` events so
    // edited files always stay current.
    const SAMPLE_TARGET = 120; // a little slack above isFresh's 100 cap
    const mtimeStride = Math.max(1, Math.floor(files.length / SAMPLE_TARGET));
    const mtimes: Record<string, number> = {};
    // A cold rebuild parses tens of thousands of files. Doing it as one
    // synchronous burst pinned the extension-host thread for 20-30s — the UI
    // and every other extension froze for the duration. Two changes keep the
    // thread cooperative: read each file's source asynchronously (so the disk
    // wait — which balloons when another extension is hammering the disk with
    // git activity — doesn't block the thread), and yield to the event loop
    // every YIELD_EVERY files so queued UI/RPC/watcher work can interleave.
    // The tree-sitter parse itself is CPU-bound and stays synchronous, but no
    // single uninterrupted span now exceeds one chunk's worth of parsing.
    const YIELD_EVERY = 200;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      let source: string | undefined;
      try {
        source = await fs.promises.readFile(f.absolutePath, "utf8");
      } catch {
        // Deleted mid-scan — parseFile(...,undefined) returns an empty ParsedFile.
        source = undefined;
      }
      const file = parseFile(f, this.opts.projectRoot, constantsSet, source);
      augmentVariadicParams(file, compilerMethodTypes);
      parsed.push(file);
      if (i % mtimeStride === 0) {
        try {
          mtimes[f.absolutePath] = (await fs.promises.stat(f.absolutePath)).mtimeMs;
        } catch {/* skip */}
      }
      if (i % 500 === 0 && i > 0) {
        this.opts.logger.info(`[Indexer]   parsed ${i}/${files.length}`);
      }
      if (i % YIELD_EVERY === YIELD_EVERY - 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    const parseMs = Date.now() - tParse;
    const tAux = Date.now();
    const plugins = discoverPlugins(this.opts.projectRoot);
    const totalPluginCommands = plugins.reduce((n, p) => n + p.commands.length, 0);
    this.opts.logger.info(
      `[Indexer] Discovered ${plugins.length} plugin bundles (${totalPluginCommands} commands total)`
    );
    // Per-plugin breakdown so zero-command bundles are visible (helps diagnose
    // manifest-format mismatches — e.g., if `PgSQL.bundle` yields 0 commands
    // it means its manifest doesn't match the shapes readPluginCommands knows).
    for (const p of plugins) {
      this.opts.logger.info(`[Indexer]   ${p.name}: ${p.commands.length} commands`);
    }
    const catalogTables = discoverCatalogTables(this.opts.projectRoot);
    this.opts.logger.info(`[Indexer] Discovered ${catalogTables.size} catalog tables`);

    const components = discoverComponents(this.opts.projectRoot);
    const totalCompMethods = components.reduce((n, c) => n + c.methods.length, 0);
    this.opts.logger.info(`[Indexer] Discovered ${components.length} components (${totalCompMethods} exposed methods)`);
    const auxMs = Date.now() - tAux;

    const tResolve = Date.now();
    const built = buildSymbolIndex(this.opts.projectRoot, parsed, plugins, catalogTables, constants, builtinConstants, variables, components);
    const resolveMs = Date.now() - tResolve;
    const idx = built.index;
    idx.fileMtimes = mtimes;

    // Record mtimes for the non-.4dm source-of-truth files so `isFresh()`
    // can detect offline edits to catalog / constants / components between
    // VSCode sessions.
    try {
      const catalogPath = path.join(this.opts.projectRoot, "Project", "Sources", "catalog.4DCatalog");
      idx.catalogMtime = fs.statSync(catalogPath).mtimeMs;
    } catch {/* catalog absent */}
    const constantsMtimes: Record<string, number> = {};
    for (const c of constants) {
      try { constantsMtimes[c.sourceFile] = fs.statSync(c.sourceFile).mtimeMs; } catch {/* skip */}
    }
    idx.constantsMtimes = constantsMtimes;
    const componentMtimes: Record<string, number> = {};
    for (const c of components) {
      if (!c.zipPath) continue;
      try { componentMtimes[c.zipPath] = fs.statSync(c.zipPath).mtimeMs; } catch {/* skip */}
    }
    idx.componentMtimes = componentMtimes;

    // Resolve numeric table ids (used as TableForms/<id> directory names) to
    // friendly table names so tree display shows `[Customers]` not `[25]`.
    const tableIdToName = discoverCatalogTableIdMap(this.opts.projectRoot);
    if (tableIdToName.size > 0) {
      for (const s of idx.symbols) {
        if (s.ownerTable && tableIdToName.has(s.ownerTable)) {
          s.ownerTable = tableIdToName.get(s.ownerTable);
        }
      }
    }

    this.currentIndex = idx;
    this.graph = new CallGraph(idx);

    const tWarm = Date.now();
    this.populateWarmCaches(parsed, built.resolverInput, built.synthOwnersByPath, idx, constantsSet);
    const warmMs = Date.now() - tWarm;
    const tPersist = Date.now();
    this.persistence.persist(idx);
    // For rebuild (cold path), wait for the cache write to land before
    // returning — callers can assume the on-disk cache reflects the rebuild.
    // Patches don't await; they let the async write finish in the background.
    await this.persistence.whenWriteSettles();
    const persistMs = Date.now() - tPersist;
    const totalMs = Date.now() - start;
    const elapsed = (totalMs / 1000).toFixed(1);
    // Phase summary — drives perf measurement across releases. Matches the
    // shape of the per-patch breakdown at the end of `patchFiles` so devs
    // can compare cold vs. incremental work units at a glance.
    const filesPerSec = parseMs > 0 ? Math.round((files.length * 1000) / parseMs) : 0;
    this.opts.logger.info(
      `[Indexer] Cold load: discover ${discoverMs}ms, parse ${parseMs}ms (${filesPerSec.toLocaleString()} files/s), aux ${auxMs}ms, resolve ${resolveMs}ms, warm ${warmMs}ms, persist ${persistMs}ms — total ${totalMs}ms`
    );
    this.opts.logger.info(
      `[Indexer] Build complete: ${idx.symbols.length} symbols, ${idx.edges.length} edges in ${elapsed}s`
    );
    this.emitter.fire(this.graph);
    return this.graph;
  }

  /**
   * Populate the incremental-patch state that the patcher uses to do its
   * surgical work. Called at the tail of every `rebuild()`; the `load()` path
   * leaves it empty so the first patch falls back to a full rebuild (which
   * then populates it).
   */
  private populateWarmCaches(
    parsed: ParsedFile[],
    resolverInput: ResolverInput,
    synthOwnersByPath: Map<string, Set<string>>,
    idx: SymbolIndex,
    constantsSet: Set<string>
  ): void {
    const parsedByPath = new Map<string, ParsedFile>();
    const symbolIdsByPath = new Map<string, Set<string>>();
    for (const p of parsed) {
      parsedByPath.set(p.file.absolutePath, p);
      const set = new Set<string>();
      for (const s of p.symbols) set.add(s.id);
      if (set.size > 0) symbolIdsByPath.set(p.file.absolutePath, set);
    }

    const edgesByFromId = new Map<string, CallEdge[]>();
    for (const e of idx.edges) {
      let list = edgesByFromId.get(e.fromId);
      if (!list) { list = []; edgesByFromId.set(e.fromId, list); }
      list.push(e);
    }

    // Reverse-name index for cross-file invalidation. Walk every parsed file's
    // rawCalls; for each call whose hint references a name that might come
    // from another file, register the (fromPath, rawCallIdx, edge, nameKey).
    // The patch path looks up by nameKey when a file's public-name set
    // changes and re-resolves the affected rawCalls in place.
    const edgesByNameKey = new Map<string, NameKeyEntry[]>();
    for (const p of parsed) {
      for (let i = 0; i < p.rawCalls.length; i++) {
        const call = p.rawCalls[i];
        if (!call.hint) continue;
        const keys = nameKeysForHint(call.hint);
        if (keys.length === 0) continue;
        const candidates = edgesByFromId.get(call.fromSymbolId) ?? [];
        const edge = candidates.find(
          (e) => e.line === call.line && e.raw === call.expression && e.column === call.column
        );
        if (!edge) continue;
        for (const k of keys) {
          let list = edgesByNameKey.get(k);
          if (!list) { list = []; edgesByNameKey.set(k, list); }
          list.push({ fromPath: p.file.absolutePath, rawCallIdx: i, edge, nameKey: k });
        }
      }
    }

    // One O(symbols) scratch build, here at the rebuild tail where the cost
    // is already amortized. From now on the patcher maintains it in lock-step
    // with the graph — saves never pay the O(symbols) table build again.
    const scratch = buildResolverScratch(resolverInput, idx.symbols);

    this.patch = {
      graph: this.graph!,
      index: idx,
      parsedByPath,
      symbolIdsByPath,
      synthOwnersByPath,
      edgesByFromId,
      edgesByNameKey,
      resolverInput,
      constantsSet,
      scratch
    };
  }

  async patchFile(absolutePath: string, kind: "change" | "delete" = "change"): Promise<void> {
    await this.patchFiles([{ path: absolutePath, kind }]);
  }

  /**
   * Apply a batch of single-file changes. Each `.4dm` change re-parses just
   * the affected file, swaps its contribution into the live index, then
   * re-resolves cross-file callers of names this file added or removed.
   * Non-`.4dm` changes fall back to a full rebuild (catalog / plugin /
   * constants are out of scope for v1 — see TODO #10).
   */
  async patchFiles(changes: { path: string; kind: "change" | "delete" | "create" }[]): Promise<void> {
    if (changes.length === 0) return;

    // If a rebuild is already in flight, that rebuild will produce a fresh
    // index that already reflects the current disk state of every file —
    // including the ones this batch is reporting. Awaiting the in-flight
    // rebuild satisfies this patch without firing another rebuild, and
    // ensures the warm caches are populated by the time we evaluate them
    // below. If files changed AFTER the rebuild captured them, the next
    // watcher event will deliver another patch with up-to-date contents.
    if (this.rebuildInFlight) {
      await this.rebuildInFlight;
    }

    if (!this.currentIndex || !this.graph) return;

    // Bail to full rebuild for changes we don't support incrementally.
    // 1) Cache cold (load() path hasn't been warmed) — populate caches by rebuilding.
    // 2) Any non-`.4dm` path — catalog / plugin / constants changes mutate the
    //    resolver context globally and aren't worth handling incrementally yet.
    // 3) Very large bursts (checkout / rebase) — a full rebuild is cheaper.
    const PATCH_BATCH_LIMIT = 50;
    const state = this.patch;
    if (!state) {
      this.opts.logger.info(`[Indexer] Warm caches cold — falling back to full rebuild`);
      await this.rebuild();
      return;
    }
    if (changes.length > PATCH_BATCH_LIMIT) {
      this.opts.logger.info(`[Indexer] ${changes.length} files changed (>${PATCH_BATCH_LIMIT}) — full rebuild`);
      await this.rebuild();
      return;
    }

    // Classify each change. Catalog / constants / components edits mutate
    // resolver context (catalog tables, constantsSet, componentByMethod)
    // that's baked into every .4dm parse + resolve — partial reindex for
    // those types isn't viable today, so fall back to a single full rebuild
    // even when mixed with .4dm changes.
    // Compiler_*.4dm edits change the project-wide variadic-params map; we
    // bail to rebuild for those too rather than trying to reconcile the
    // delta with every existing ProjectMethod symbol's `params[]`.
    const categories = changes.map((c) => classifyChange(c.path, this.opts.projectRoot));
    const hasCompilerEdit = changes.some(
      (c) => /\/Compiler_[^/]*\.4dm$/i.test(c.path),
    );
    if (hasCompilerEdit) {
      // Compiler_*.4dm declares the project-wide variadic-params map
      // consumed by augmentVariadicParams. A full rebuild is only needed
      // if the edit changed a `C_<TYPE>(<method>; $N)` declaration —
      // comment / whitespace / `#DECLARE` edits leave the map intact,
      // and the file's own ProjectMethod symbols can be patched like any
      // other .4dm. Re-discover and compare; downgrade to incremental
      // when unchanged.
      const fresh = discoverCompilerMethodTypes(this.opts.projectRoot);
      const same = this.compilerMethodTypes
        ? compilerMethodTypesEqual(this.compilerMethodTypes, fresh)
        : false;
      if (!same) {
        this.opts.logger.info(`[Indexer] Compiler_*.4dm signature change — full rebuild`);
        await this.rebuild();
        return;
      }
      this.opts.logger.info(`[Indexer] Compiler_*.4dm edit but signatures unchanged — incremental patch`);
      // Fall through to normal .4dm patch path.
    }
    if (categories.some((cat) => cat === "catalog" || cat === "constants" || cat === "components")) {
      const which = categories.find((c) => c === "catalog" || c === "constants" || c === "components");
      this.opts.logger.info(`[Indexer] ${which} change in batch — full rebuild`);
      await this.rebuild();
      return;
    }
    // Discard anything the classifier doesn't recognize (defensive — the
    // watcher should not deliver these). Continue with the .4dm-only path.
    const codeChanges = changes.filter((_, i) => categories[i] === "code");
    if (codeChanges.length === 0) {
      this.opts.logger.info(`[Indexer] No recognized .4dm changes in batch — skipping`);
      return;
    }

    const start = Date.now();
    const affectedNameKeys = new Set<string>();
    const changedPaths = new Set(codeChanges.map((c) => c.path));

    // Per-phase timing buckets so we can see where a slow save spends its
    // budget without sprinkling .info() through every helper.
    let tRemove = 0, tParse = 0, tAdd = 0;
    let nAffectedEdges = 0;

    // Yield to the event loop every PATCH_YIELD_EVERY files so a near-limit
    // batch (up to PATCH_BATCH_LIMIT) doesn't hold the thread for one long
    // span; single-file saves (the common case) take exactly one iteration.
    const PATCH_YIELD_EVERY = 25;
    let processed = 0;
    for (const change of codeChanges) {
      const exists = fs.existsSync(change.path);
      const effective: "change" | "delete" = !exists ? "delete" : (change.kind === "delete" ? "delete" : "change");

      const t0 = Date.now();
      const oldKeys = removeFileContribution(state, change.path);
      tRemove += Date.now() - t0;
      for (const k of oldKeys) affectedNameKeys.add(k);

      if (effective === "delete") {
        delete this.currentIndex.fileMtimes[change.path];
        // Evict the tree-sitter cache entry too so a future create at the
        // same path doesn't accidentally diff against the deleted file's
        // stale source.
        try {
          const ts: typeof import("../parser/parseWithTreeSitter") = require("../parser/parseWithTreeSitter");
          ts.invalidateTreeCache(change.path);
        } catch {/* parser module not loaded — nothing to evict */}
        continue;
      }

      const discovered = classifyFile(change.path, this.opts.projectRoot);
      if (!discovered) continue;
      const t1 = Date.now();
      // Read asynchronously so the disk wait stays off the thread (matters
      // when git churn is saturating the disk); a missing file yields an
      // empty parse via the undefined-source fallback.
      let source: string | undefined;
      try {
        source = await fs.promises.readFile(change.path, "utf8");
      } catch {
        source = undefined;
      }
      const parsed = parseFile(discovered, this.opts.projectRoot, state.constantsSet, source);
      tParse += Date.now() - t1;
      // Re-apply variadic-param augmentation (Compiler_*.4dm types). The
      // map is per-project and cached on the indexer; a Compiler_* edit
      // would route to full rebuild via the explicit check below, so we
      // can safely reuse the cached map here.
      if (this.compilerMethodTypes) {
        augmentVariadicParams(parsed, this.compilerMethodTypes);
      }
      try { this.currentIndex.fileMtimes[change.path] = fs.statSync(change.path).mtimeMs; } catch {/* skip */}

      const t2 = Date.now();
      const newKeys = addFileContribution(state, parsed);
      tAdd += Date.now() - t2;
      for (const k of newKeys) affectedNameKeys.add(k);

      if (++processed % PATCH_YIELD_EVERY === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    const tFanoutStart = Date.now();
    nAffectedEdges = reresolveAffectedDependents(state, affectedNameKeys, changedPaths);
    const tFanout = Date.now() - tFanoutStart;

    const tAssertStart = Date.now();
    const driftOk = assertSynthRefcountInvariant(state);
    const tAssert = Date.now() - tAssertStart;
    if (!driftOk) {
      this.opts.logger.warn(`[Indexer] Synth refcount drift detected — falling back to full rebuild`);
      await this.rebuild();
      return;
    }

    const tPersistStart = Date.now();
    this.persistence.schedulePersist(this.currentIndex);
    const tPersist = Date.now() - tPersistStart;
    const elapsed = Date.now() - start;
    this.opts.logger.info(
      `[Indexer] Patched ${codeChanges.length} file(s) in ${elapsed}ms ` +
      `(remove ${tRemove}ms, parse ${tParse}ms, add ${tAdd}ms, fanout ${tFanout}ms [${nAffectedEdges} edges], ` +
      `assert ${tAssert}ms, persist-schedule ${tPersist}ms, ` +
      `symbols=${this.currentIndex.symbols.length}, edges=${this.currentIndex.edges.length}, ` +
      `nameKeys=${state.edgesByNameKey.size})`
    );
    this.emitter.fire(this.graph);
  }

  /**
   * Absolute path the indexer reads from / writes to. Exposed so tooling
   * (tests, the `callchain.reindex` command, diagnostics) can locate the
   * cache without duplicating the hash-suffix logic.
   */
  getCachePath(): string {
    return this.persistence.indexPath();
  }

  /**
   * Force any pending debounced persist to run immediately and wait for the
   * (async) write to land on disk. Call before process exit / before reading
   * the cache file in tests to make sure on-disk state matches in-memory.
   */
  async flushPersist(): Promise<void> {
    await this.persistence.flushPersist(this.currentIndex);
  }
}
