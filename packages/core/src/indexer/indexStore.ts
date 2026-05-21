import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { pack, unpack } from "msgpackr";
import { CallEdge, INDEX_VERSION, RawCallSite, SymbolIndex, SymbolKind, SymbolRecord } from "../model/symbol";
import { CallGraph } from "../model/callGraph";
import { Logger } from "../util/logger";
import { TypedEmitter } from "../util/emitter";
import { discoverCatalogTableIdMap, discoverCatalogTables, discoverFiles, discoverPlugins } from "./projectScanner";
import { DEFAULT_BUILTIN_CONSTANTS_PROBES, discoverBuiltinConstants, discoverConstants } from "./constantsScanner";
import { discoverVariables } from "./variableScanner";
import { discoverCompilerMethodTypes, mergeCompilerParamsWithDeclare, CompilerMethodTypes } from "./compilerMethodScanner";
import { discoverComponents, findBundledComponentRoots } from "./componentScanner";
import { ParsedFile, parseFile } from "./fileParser";
import { buildResolverScratch, buildSymbolIndex, resolveCallsForFile, ResolverInput } from "./nameResolver";
import { classifyFile } from "./projectScanner";

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

// Binary msgpack file — 3–5× faster to encode and ~2× smaller than the old
// JSON cache. Pre-v29 caches used `callchain-index.json`; those are simply
// ignored (load() falls through to `rebuild()` when neither file is fresh).
// The filename is suffixed with a short hash of the absolute project root
// so two projects sharing the same `.vscode/` directory (multi-root
// workspaces, sibling project subfolders) don't trample each other's caches.
const INDEX_FILENAME_PREFIX = "callchain-index";
const INDEX_FILENAME_SUFFIX = ".msgpack";

function cacheFileNameFor(projectRoot: string): string {
  const canonical = path.resolve(projectRoot);
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  return `${INDEX_FILENAME_PREFIX}-${hash}${INDEX_FILENAME_SUFFIX}`;
}

/**
 * Reverse-name index entry for cross-file invalidation. Each entry remembers
 * the source file + the index into that file's rawCalls so the patch path can
 * re-resolve the exact call site when a referenced name changes.
 */
interface NameKeyEntry {
  fromPath: string;
  rawCallIdx: number;
  edge: CallEdge;
  nameKey: string;
}

export class Indexer {
  private currentIndex: SymbolIndex | undefined;
  private graph: CallGraph | undefined;
  private readonly emitter = new TypedEmitter<CallGraph>();
  readonly onDidUpdate = this.emitter.event;

  // ── Incremental-index warm caches (populated by rebuild() / lazy on load()) ──
  private parsedByPath: Map<string, ParsedFile> | undefined;
  private symbolIdsByPath: Map<string, Set<string>> | undefined;
  private synthOwnersByPath: Map<string, Set<string>> | undefined;
  private edgesByFromId: Map<string, CallEdge[]> | undefined;
  private edgesByNameKey: Map<string, NameKeyEntry[]> | undefined;
  private resolverInput: ResolverInput | undefined;
  private constantsSet: Set<string> | undefined;
  // Cached per-method parameter-type info from Compiler_*.4dm. Refreshed on
  // full rebuild only — Compiler_* edits route through `patchFile` →
  // full-rebuild bail (see patchFiles).
  private compilerMethodTypes: Map<string, CompilerMethodTypes> | undefined;
  private pendingPersist: ReturnType<typeof setTimeout> | undefined;
  private inFlightPersist: Promise<void> | undefined;
  // Tracks an in-progress full rebuild so concurrent patch calls (or other
  // rebuild requests) await the same work instead of starting their own.
  // Without this, the first save after `load()` triggers a rebuild AND
  // subsequent saves arriving during that rebuild each trigger another,
  // causing N concurrent ~25s rebuilds scribbling over the same state.
  private rebuildInFlight: Promise<CallGraph> | undefined;

  constructor(private readonly opts: IndexerOptions) {}

  getGraph(): CallGraph | undefined {
    return this.graph;
  }

  async load(): Promise<CallGraph> {
    const cachePath = this.indexPath();
    if (fs.existsSync(cachePath)) {
      try {
        const tRead = Date.now();
        const buf = fs.readFileSync(cachePath);
        const raw = unpack(buf) as SymbolIndex;
        const readMs = Date.now() - tRead;
        if (raw.version === INDEX_VERSION && (await this.isFresh(raw))) {
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
    const mtimes: Record<string, number> = {};
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const file = parseFile(f, this.opts.projectRoot, constantsSet);
      augmentVariadicParams(file, compilerMethodTypes);
      parsed.push(file);
      try {
        mtimes[f.absolutePath] = fs.statSync(f.absolutePath).mtimeMs;
      } catch {/* skip */}
      if (i % 500 === 0 && i > 0) {
        this.opts.logger.info(`[Indexer]   parsed ${i}/${files.length}`);
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
    this.persist(idx);
    // For rebuild (cold path), wait for the cache write to land before
    // returning — callers can assume the on-disk cache reflects the rebuild.
    // Patches don't await; they let the async write finish in the background.
    if (this.inFlightPersist) await this.inFlightPersist;
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
   * Populate the per-file warm caches that `patchFile()` uses to do its
   * surgical work. Called at the tail of every `rebuild()`; the `load()` path
   * leaves them empty so the first patch falls back to a full rebuild (which
   * then populates these).
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

    this.parsedByPath = parsedByPath;
    this.symbolIdsByPath = symbolIdsByPath;
    this.synthOwnersByPath = synthOwnersByPath;
    this.edgesByFromId = edgesByFromId;
    this.edgesByNameKey = edgesByNameKey;
    this.resolverInput = resolverInput;
    this.constantsSet = constantsSet;
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
    if (!this.parsedByPath || !this.symbolIdsByPath || !this.synthOwnersByPath || !this.edgesByFromId
        || !this.edgesByNameKey || !this.resolverInput || !this.constantsSet) {
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

    for (const change of codeChanges) {
      const exists = fs.existsSync(change.path);
      const effective: "change" | "delete" = !exists ? "delete" : (change.kind === "delete" ? "delete" : "change");

      const t0 = Date.now();
      const oldKeys = this.removeFileContribution(change.path);
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
      const parsed = parseFile(discovered, this.opts.projectRoot, this.constantsSet);
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
      const newKeys = this.addFileContribution(parsed);
      tAdd += Date.now() - t2;
      for (const k of newKeys) affectedNameKeys.add(k);
    }

    const tFanoutStart = Date.now();
    nAffectedEdges = this.reresolveAffectedDependents(affectedNameKeys, changedPaths);
    const tFanout = Date.now() - tFanoutStart;

    const tAssertStart = Date.now();
    const driftOk = this.assertSynthRefcountInvariant();
    const tAssert = Date.now() - tAssertStart;
    if (!driftOk) {
      this.opts.logger.warn(`[Indexer] Synth refcount drift detected — falling back to full rebuild`);
      await this.rebuild();
      return;
    }

    const tPersistStart = Date.now();
    this.schedulePersist(this.currentIndex);
    const tPersist = Date.now() - tPersistStart;
    const elapsed = Date.now() - start;
    this.opts.logger.info(
      `[Indexer] Patched ${codeChanges.length} file(s) in ${elapsed}ms ` +
      `(remove ${tRemove}ms, parse ${tParse}ms, add ${tAdd}ms, fanout ${tFanout}ms [${nAffectedEdges} edges], ` +
      `assert ${tAssert}ms, persist-schedule ${tPersist}ms, ` +
      `symbols=${this.currentIndex.symbols.length}, edges=${this.currentIndex.edges.length}, ` +
      `nameKeys=${this.edgesByNameKey.size})`
    );
    this.emitter.fire(this.graph);
  }

  /**
   * Drop everything a single `.4dm` file contributed to the live index:
   * its file-owned symbols, the edges originating from them, and any
   * synth-symbol refcount it held. Returns the set of public-name keys
   * that file previously published (so the patch path can decide which
   * cross-file edges might now need re-resolution).
   */
  private removeFileContribution(absolutePath: string): Set<string> {
    const removedNameKeys = new Set<string>();
    if (!this.parsedByPath || !this.symbolIdsByPath || !this.synthOwnersByPath
        || !this.edgesByFromId || !this.edgesByNameKey || !this.graph || !this.currentIndex) {
      return removedNameKeys;
    }
    const oldParsed = this.parsedByPath.get(absolutePath);
    const oldSyms = this.symbolIdsByPath.get(absolutePath) ?? new Set<string>();
    const oldSynths = this.synthOwnersByPath.get(absolutePath) ?? new Set<string>();

    // Track public names this file previously published — caller may need
    // them to decide whether cross-file edges need re-resolution.
    if (oldParsed) {
      for (const s of oldParsed.symbols) {
        removedNameKeys.add(s.name.toLowerCase());
        if (s.ownerClass) removedNameKeys.add(`${s.ownerClass}.${s.name}`.toLowerCase());
      }
    }

    // Drop the file's symbols + outgoing edges via the graph's batched op.
    // We only remove outgoing edges by default — incoming edges (from other
    // files calling into this one) stay in place so the fan-out path can
    // re-resolve them precisely. Because every edge removed here originates
    // from a symbol owned by THIS file, the corresponding name-key entries
    // are already covered by `dropNameKeyEntriesForFile(absolutePath)` —
    // no per-edge bucket scan needed.
    if (oldSyms.size > 0) {
      this.graph.removeSymbolsByIds(oldSyms);
      for (const id of oldSyms) this.edgesByFromId.delete(id);
    }
    this.dropNameKeyEntriesForFile(absolutePath);

    // Synth refcount: decrement each synth this file owned. If a synth's
    // refcount drops to zero, remove the symbol entirely.
    for (const synthId of oldSynths) {
      const sym = this.graph.symbol(synthId);
      if (!sym?.fileOrigins) continue;
      const next = sym.fileOrigins.filter((p) => p !== absolutePath);
      if (next.length === 0) {
        this.graph.removeSymbolsByIds([synthId]);
        this.edgesByFromId.delete(synthId);
      } else {
        sym.fileOrigins = next;
      }
    }
    this.synthOwnersByPath.delete(absolutePath);

    this.parsedByPath.delete(absolutePath);
    this.symbolIdsByPath.delete(absolutePath);

    return removedNameKeys;
  }

  /**
   * Drop every `edgesByNameKey` entry whose `fromPath` matches the given
   * file. Used during `removeFileContribution` so name-key lookups don't
   * surface stale entries pointing at a removed rawCall.
   */
  private dropNameKeyEntriesForFile(absolutePath: string): void {
    if (!this.edgesByNameKey) return;
    for (const [key, entries] of this.edgesByNameKey) {
      const filtered = entries.filter((e) => e.fromPath !== absolutePath);
      if (filtered.length === 0) this.edgesByNameKey.delete(key);
      else this.edgesByNameKey.set(key, filtered);
    }
  }

  /**
   * Add a freshly-parsed file's contribution to the live index: insert its
   * symbols, then re-resolve its rawCalls against the current global symbol
   * table and add the resulting edges. Returns the file's published
   * public-name keys (a superset of what the caller will diff against the
   * pre-removal set for cross-file invalidation).
   */
  private addFileContribution(parsed: ParsedFile): Set<string> {
    const added = new Set<string>();
    if (!this.parsedByPath || !this.symbolIdsByPath || !this.synthOwnersByPath
        || !this.edgesByFromId || !this.edgesByNameKey || !this.graph
        || !this.currentIndex || !this.resolverInput) return added;

    const fp = parsed.file.absolutePath;
    const newIds = new Set<string>();
    for (const s of parsed.symbols) {
      this.graph.addSymbol(s);
      newIds.add(s.id);
      added.add(s.name.toLowerCase());
      if (s.ownerClass) added.add(`${s.ownerClass}.${s.name}`.toLowerCase());
    }
    this.symbolIdsByPath.set(fp, newIds);
    this.parsedByPath.set(fp, parsed);

    // Update resolverInput's per-file overlays for project classes. The
    // resolver consults `projectClassPropsByName` / `projectClassMethodReturnsByName`
    // when walking $x.foo.bar chains, so they must reflect the current file
    // before we re-resolve any calls.
    if (parsed.classInfo) {
      const key = parsed.classInfo.name.toLowerCase();
      if (parsed.classPropertyTypes) {
        let map = this.resolverInput.projectClassPropsByName?.get(key);
        if (!map) { map = new Map(); this.resolverInput.projectClassPropsByName?.set(key, map); }
        for (const [p, t] of parsed.classPropertyTypes) map.set(p, t);
      }
      if (parsed.classMethodReturnsByName) {
        let map = this.resolverInput.projectClassMethodReturnsByName?.get(key);
        if (!map) { map = new Map(); this.resolverInput.projectClassMethodReturnsByName?.set(key, map); }
        for (const [m, t] of parsed.classMethodReturnsByName) map.set(m, t);
      }
    }

    // Build a fresh ResolverScratch over the current global symbol set, then
    // resolve just this file's calls. The scratch's setCurrentFileOrigin
    // attributes any new synth symbols to this file.
    const scratch = buildResolverScratch(this.resolverInput, this.currentIndex.symbols);
    const newEdges = resolveCallsForFile(parsed, scratch);

    // Merge any synth symbols the resolver created during this patch into
    // the live index. (buildResolverScratch starts with an empty `unresolved`,
    // so this list only contains synths the current file created — or that
    // existed before but got re-created because the scratch was fresh. We
    // dedup against the graph's existing symbols by id.)
    for (const u of scratch.unresolved) {
      const existing = this.graph.symbol(u.id);
      if (existing) {
        // Carry over the new fileOrigins entries (recordSynthOwner already set
        // u.fileOrigins to [fp]).
        const next = existing.fileOrigins ?? [];
        if (!next.includes(fp)) next.push(fp);
        existing.fileOrigins = next;
      } else {
        this.graph.addSymbol(u);
      }
    }
    // Merge synthOwnersByPath: for incremental builds, the scratch tracks just
    // this patch's synths under `fp`.
    const synths = scratch.synthOwnersByPath.get(fp);
    if (synths) {
      let existing = this.synthOwnersByPath.get(fp);
      if (!existing) { existing = new Set(); this.synthOwnersByPath.set(fp, existing); }
      for (const id of synths) existing.add(id);
    }

    // Append edges to the live index + maintain edgesByFromId and edgesByNameKey.
    for (const e of newEdges) {
      this.graph.addEdge(e);
      let list = this.edgesByFromId.get(e.fromId);
      if (!list) { list = []; this.edgesByFromId.set(e.fromId, list); }
      list.push(e);
    }
    // Reverse-name index for the new edges.
    for (let i = 0; i < parsed.rawCalls.length; i++) {
      const call = parsed.rawCalls[i];
      if (!call.hint) continue;
      const keys = nameKeysForHint(call.hint);
      if (keys.length === 0) continue;
      const edge = newEdges.find(
        (e) => e.fromId === call.fromSymbolId && e.line === call.line && e.raw === call.expression && e.column === call.column
      );
      if (!edge) continue;
      for (const k of keys) {
        let list = this.edgesByNameKey.get(k);
        if (!list) { list = []; this.edgesByNameKey.set(k, list); }
        list.push({ fromPath: fp, rawCallIdx: i, edge, nameKey: k });
      }
    }

    return added;
  }

  /**
   * After per-file changes have been applied, re-resolve every call site in
   * OTHER files whose `nameKey` matches a name this batch added or removed.
   * The reverse-name index (`edgesByNameKey`) tells us exactly which
   * rawCalls reference any given name, so the fan-out is bounded by the
   * number of cross-file references — not the project size.
   *
   * Calls inside the patched files themselves are NOT re-resolved here:
   * `addFileContribution` already resolves the changed file's own rawCalls
   * fresh against the post-patch symbol table.
   */
  private reresolveAffectedDependents(affectedNameKeys: Set<string>, changedPaths: Set<string>): number {
    if (affectedNameKeys.size === 0) return 0;
    if (!this.parsedByPath || !this.symbolIdsByPath || !this.synthOwnersByPath
        || !this.edgesByFromId || !this.edgesByNameKey || !this.graph
        || !this.currentIndex || !this.resolverInput) return 0;

    // Collect unique (fromPath, rawCallIdx) pairs from all affected name
    // keys. The same rawCall is indexed under multiple keys (e.g. CsCall
    // by both className AND method) so we dedup to re-resolve once per
    // call site.
    const toResolve = new Map<string, { fromPath: string; rawCallIdx: number }>();
    for (const key of affectedNameKeys) {
      const entries = this.edgesByNameKey.get(key);
      if (!entries) continue;
      for (const entry of entries) {
        if (changedPaths.has(entry.fromPath)) continue;
        const dedupKey = `${entry.fromPath}|${entry.rawCallIdx}`;
        if (!toResolve.has(dedupKey)) toResolve.set(dedupKey, { fromPath: entry.fromPath, rawCallIdx: entry.rawCallIdx });
      }
    }
    if (toResolve.size === 0) return 0;

    // Build one scratch over the current global symbol set; reuse for every
    // affected call site (the scratch is O(symbols) to build, so we want
    // to amortize even for a handful of call sites).
    const scratch = buildResolverScratch(this.resolverInput, this.currentIndex.symbols);

    // Group the affected calls by file so we can build mini-ParsedFile
    // clones (each with one rawCall) and call resolveCallsForFile.
    const byFile = new Map<string, Array<{ rawCallIdx: number }>>();
    for (const { fromPath, rawCallIdx } of toResolve.values()) {
      let list = byFile.get(fromPath);
      if (!list) { list = []; byFile.set(fromPath, list); }
      list.push({ rawCallIdx });
    }

    for (const [fromPath, items] of byFile) {
      const parsed = this.parsedByPath.get(fromPath);
      if (!parsed) continue;
      for (const { rawCallIdx } of items) {
        const call = parsed.rawCalls[rawCallIdx];
        if (!call?.hint) continue;
        const keys = nameKeysForHint(call.hint);

        // Find and remove the existing edge for this rawCall.
        const candidates = this.edgesByFromId.get(call.fromSymbolId) ?? [];
        const oldEdge = candidates.find(
          (e) => e.line === call.line && e.raw === call.expression && e.column === call.column
        );
        if (oldEdge) {
          this.graph.removeEdge(oldEdge);
          // Remove from edgesByFromId
          const list = this.edgesByFromId.get(call.fromSymbolId);
          if (list) {
            const i = list.indexOf(oldEdge);
            if (i >= 0) list.splice(i, 1);
            if (list.length === 0) this.edgesByFromId.delete(call.fromSymbolId);
          }
          // Drop the edge's entries from edgesByNameKey, but only in the
          // buckets this rawCall actually published — `keys` is small (1–2
          // names from `nameKeysForHint`). The general `dropEdgeFromNameKeyIndex`
          // would scan all ~30k buckets per edge and dominate the fan-out cost.
          for (const k of keys) {
            const bucket = this.edgesByNameKey.get(k);
            if (!bucket) continue;
            const filtered = bucket.filter((entry) => entry.edge !== oldEdge);
            if (filtered.length === 0) this.edgesByNameKey.delete(k);
            else if (filtered.length !== bucket.length) this.edgesByNameKey.set(k, filtered);
          }
          // The old edge may have targeted a synth — decrement the synth's
          // refcount via the calling file. If we owned the only reference,
          // the synth is now orphaned; let the graph drop it.
          this.decrementSynthRef(oldEdge.toId, fromPath);
        }

        // Re-resolve this single rawCall against the fresh scratch.
        const miniParsed = { ...parsed, rawCalls: [call] };
        const newEdges = resolveCallsForFile(miniParsed, scratch);
        for (const e of newEdges) {
          this.graph.addEdge(e);
          let list = this.edgesByFromId.get(e.fromId);
          if (!list) { list = []; this.edgesByFromId.set(e.fromId, list); }
          list.push(e);
          for (const k of keys) {
            let bucket = this.edgesByNameKey.get(k);
            if (!bucket) { bucket = []; this.edgesByNameKey.set(k, bucket); }
            bucket.push({ fromPath, rawCallIdx, edge: e, nameKey: k });
          }
        }
      }
    }

    // Merge any new synth symbols the re-resolution produced.
    for (const u of scratch.unresolved) {
      const existing = this.graph.symbol(u.id);
      if (existing) {
        // Carry over any new fileOrigins entries the scratch recorded.
        const next = existing.fileOrigins ?? [];
        for (const origin of u.fileOrigins ?? []) {
          if (!next.includes(origin)) next.push(origin);
        }
        existing.fileOrigins = next;
      } else {
        this.graph.addSymbol(u);
      }
    }
    // Merge synthOwnersByPath: scratch tracked synths per file during this
    // fan-out; fold those into the live map.
    for (const [origin, ids] of scratch.synthOwnersByPath) {
      let existing = this.synthOwnersByPath.get(origin);
      if (!existing) { existing = new Set(); this.synthOwnersByPath.set(origin, existing); }
      for (const id of ids) existing.add(id);
    }
    return toResolve.size;
  }

  /**
   * Decrement a synthetic symbol's refcount for a specific source file. If
   * the symbol is no longer referenced by any file, remove it from the
   * graph entirely. Used when a cross-file edge is being rebound to a new
   * target during fan-out.
   */
  private decrementSynthRef(synthId: string, fromPath: string): void {
    if (!this.graph || !this.synthOwnersByPath) return;
    const sym = this.graph.symbol(synthId);
    if (!sym?.fileOrigins) return; // not a synth (or no tracking)
    const next = sym.fileOrigins.filter((p) => p !== fromPath);
    const owners = this.synthOwnersByPath.get(fromPath);
    if (owners) owners.delete(synthId);
    if (next.length === 0) {
      this.graph.removeSymbolsByIds([synthId]);
      this.edgesByFromId?.delete(synthId);
    } else {
      sym.fileOrigins = next;
    }
  }

  /**
   * Verify that synthetic-symbol refcounts match the per-file ownership map.
   * Sum of `synthOwnersByPath[*].size` must equal sum over synth symbols of
   * `fileOrigins.length`. Drift indicates a bug in the patch path — returns
   * `false` so the caller can fall back to a full rebuild rather than serve
   * a corrupted graph. Cheap: O(synth count).
   */
  private assertSynthRefcountInvariant(): boolean {
    if (!this.graph || !this.synthOwnersByPath) return true;
    let ownersTotal = 0;
    for (const owners of this.synthOwnersByPath.values()) ownersTotal += owners.size;
    let originsTotal = 0;
    for (const s of this.graph.allSymbols()) {
      if (s.kind === SymbolKind.Builtin || s.kind === SymbolKind.TableBuiltin || s.kind === SymbolKind.Unresolved) {
        originsTotal += s.fileOrigins?.length ?? 0;
      }
    }
    return ownersTotal === originsTotal;
  }

  private async isFresh(raw: SymbolIndex): Promise<boolean> {
    if (raw.projectRoot !== this.opts.projectRoot) return false;

    // .4dm files: sample up to 100 mtimes (large projects have thousands;
    // a sample is much cheaper than statting every file).
    let checked = 0;
    for (const [p, mtime] of Object.entries(raw.fileMtimes)) {
      try {
        const stat = fs.statSync(p);
        if (Math.abs(stat.mtimeMs - mtime) > 1) return false;
      } catch {
        return false;
      }
      checked++;
      if (checked > 100) break;
    }

    // catalog.4DCatalog: a single file. Check unconditionally.
    if (raw.catalogMtime !== undefined) {
      const catalogPath = path.join(this.opts.projectRoot, "Project", "Sources", "catalog.4DCatalog");
      try {
        const stat = fs.statSync(catalogPath);
        if (Math.abs(stat.mtimeMs - raw.catalogMtime) > 1) return false;
      } catch {
        // Catalog was removed since cache was written.
        return false;
      }
    }

    // Constants and component files: bounded small (tens). Check all entries.
    if (!checkAllMtimesFresh(raw.constantsMtimes)) return false;
    if (!checkAllMtimesFresh(raw.componentMtimes)) return false;

    // File-set membership change: if the on-disk set of Constants_*.xlf or
    // component .4DZ files differs from the cached keys, treat as stale.
    if (!checkFileSetUnchanged(raw.constantsMtimes, () => listConstantsFiles(this.opts.projectRoot))) return false;
    if (!checkFileSetUnchanged(raw.componentMtimes, () => listComponentArchives(this.opts.projectRoot))) return false;

    return true;
  }

  private indexPath(): string {
    const dir = this.opts.cacheDir ?? path.join(this.opts.projectRoot, ".vscode");
    return path.join(dir, cacheFileNameFor(this.opts.projectRoot));
  }

  /**
   * Absolute path the indexer reads from / writes to. Exposed so tooling
   * (tests, the `callchain.reindex` command, diagnostics) can locate the
   * cache without duplicating the hash-suffix logic.
   */
  getCachePath(): string {
    return this.indexPath();
  }

  private persist(idx: SymbolIndex): void {
    // Persist is fire-and-forget. The on-disk cache is only consulted at the
    // next process start; correctness during the running session relies on
    // the in-memory index. We use msgpack instead of JSON so the encode is
    // 3–5× faster and the resulting buffer is roughly half the size — both
    // matter because the previous JSON path blocked the event loop for
    // 1–2 seconds while stringifying a 150 MB index. The actual disk write
    // still goes through `fs.promises.writeFile` so the I/O doesn't block.
    try {
      const dir = path.dirname(this.indexPath());
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tEncode = Date.now();
      const buf = pack(idx);
      const encodeMs = Date.now() - tEncode;
      const sizeKb = Math.round(buf.length / 1024);
      const tWrite = Date.now();
      this.inFlightPersist = fs.promises
        .writeFile(this.indexPath(), buf)
        .then(() => {
          const writeMs = Date.now() - tWrite;
          this.opts.logger.info(
            `[Indexer] Persisted cache (${sizeKb}KB, encode ${encodeMs}ms, write ${writeMs}ms async)`
          );
        })
        .catch((err) => this.opts.logger.warn(`[Indexer] Persist write failed: ${err}`))
        .finally(() => { this.inFlightPersist = undefined; });
    } catch (err) {
      this.opts.logger.warn(`[Indexer] Persist failed: ${err}`);
    }
  }

  /**
   * Persist the index to disk. If `persistDebounceMs > 0`, coalesce
   * back-to-back saves onto one timer so a burst of patches only writes the
   * cache once. Default is synchronous so test snapshots see fresh state.
   */
  private schedulePersist(idx: SymbolIndex): void {
    const delay = this.opts.persistDebounceMs ?? 0;
    if (delay <= 0) {
      this.persist(idx);
      return;
    }
    if (this.pendingPersist) clearTimeout(this.pendingPersist);
    this.pendingPersist = setTimeout(() => {
      this.pendingPersist = undefined;
      this.persist(idx);
    }, delay);
    // Don't keep the process alive solely for the debounce timer.
    (this.pendingPersist as any).unref?.();
  }

  /**
   * Force any pending debounced persist to run immediately and wait for the
   * (async) write to land on disk. Call before process exit / before reading
   * the cache file in tests to make sure on-disk state matches in-memory.
   */
  async flushPersist(): Promise<void> {
    if (this.pendingPersist) {
      clearTimeout(this.pendingPersist);
      this.pendingPersist = undefined;
      if (this.currentIndex) this.persist(this.currentIndex);
    }
    if (this.inFlightPersist) await this.inFlightPersist;
  }
}

/**
 * For each `CallHint` shape, return the lowercase names that the resolver
 * keys on to pick an edge target. The patch path uses these as the keys of
 * `edgesByNameKey` so adding/removing a public name only requires looking
 * up the calls that mention it.
 *
 * Local-only references (e.g. `$variable` in VarCall) are NOT included —
 * a file's local variable can't be referenced from another file.
 */
function nameKeysForHint(hint: NonNullable<RawCallSite["hint"]>): string[] {
  const lc = (s: string) => s.toLowerCase();
  switch (hint.kind) {
    case "BareName":
    case "BuiltinChain":
    case "ConstantRef":
    case "InterprocessRef":
    case "ProjectMethodBare":
      return [lc(hint.name)];
    case "CsNew":
      return [lc(hint.className)];
    case "CsCall":
      return [lc(hint.className), lc(hint.method)];
    case "CsNewNs":
      return [lc(`cs.${hint.namespace}.${hint.className}`)];
    case "CsCallNs":
      return [lc(`cs.${hint.namespace}.${hint.className}`), lc(hint.method)];
    case "CsGetNs":
    case "CsSetNs":
      return [lc(`cs.${hint.namespace}.${hint.className}`), lc(hint.property)];
    case "DsCall":
      return [lc(hint.className), lc(hint.method)];
    case "DsAccess":
      return [lc(hint.className)];
    case "ThisCall":
    case "VarCall":
    case "VarChainCall":
    case "ThisChainCall":
      return [lc(hint.method)];
    case "SuperCall":
      return hint.method ? [lc(hint.method)] : ["constructor"];
    case "ThisGet":
    case "ThisSet":
    case "VarGet":
    case "VarSet":
      return [lc(hint.property)];
    case "CsGet":
    case "CsSet":
      return [lc(hint.className), lc(hint.property)];
    case "DsBracketNew":
      return [lc(hint.ident)];
    case "DsBracketCall":
      return [lc(hint.ident), lc(hint.method)];
    case "FormRef":
      return [lc(hint.formName)];
    case "CallWorker":
    case "NewProcess":
    case "ExecuteMethodLiteral":
      return [lc(hint.methodName)];
    case "ExecuteMethodInSubform":
      return [lc(hint.formName), lc(hint.methodName)];
    case "ExecuteMethodDynamic":
    case "Formula":
      return [];
  }
}

/**
 * Verify every cached mtime matches the file's current mtime on disk. Returns
 * false if any file is missing or differs by more than 1 ms. Bounded small
 * (tens of files at most), so check every entry — unlike the .4dm sampling.
 */
function checkAllMtimesFresh(mtimes: Record<string, number> | undefined): boolean {
  if (!mtimes) return true;
  for (const [p, cached] of Object.entries(mtimes)) {
    try {
      const stat = fs.statSync(p);
      if (Math.abs(stat.mtimeMs - cached) > 1) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Detect file-set membership changes: a new Constants_*.xlf or .4DZ that
 * appeared (or disappeared) since the cache was written invalidates the
 * cache even if all stored mtimes still match.
 */
function checkFileSetUnchanged(mtimes: Record<string, number> | undefined, listFn: () => string[]): boolean {
  const cached = new Set(Object.keys(mtimes ?? {}));
  const onDisk = new Set(listFn());
  if (cached.size !== onDisk.size) return false;
  for (const p of cached) if (!onDisk.has(p)) return false;
  return true;
}

/** Mirror of `discoverConstants()`'s glob, used by `isFresh()` for set-membership checks. */
function listConstantsFiles(projectRoot: string): string[] {
  const resourcesDir = path.join(projectRoot, "Resources");
  if (!fs.existsSync(resourcesDir)) return [];
  const out: string[] = [];
  try {
    for (const entry of fs.readdirSync(resourcesDir)) {
      if (entry.startsWith("Constants_") && entry.endsWith(".xlf")) {
        out.push(path.join(resourcesDir, entry));
      }
    }
  } catch {/* ignore */}
  return out;
}

/** Mirror of `discoverComponents()`'s archive enumeration. Walks both the
 *  project-local `Components/` directory and any 4D-bundled Components/
 *  directories so cache-freshness checks see the same archive set the
 *  scanner does. Project-local wins on collision (matches discoverComponents). */
function listComponentArchives(projectRoot: string): string[] {
  const out: string[] = [];
  const seenComponents = new Set<string>();
  const harvest = (componentsRoot: string) => {
    if (!fs.existsSync(componentsRoot)) return;
    try {
      for (const entry of fs.readdirSync(componentsRoot)) {
        if (!entry.endsWith(".4dbase")) continue;
        const name = entry.replace(/\.4dbase$/, "");
        if (seenComponents.has(name)) continue;
        seenComponents.add(name);
        const bundle = path.join(componentsRoot, entry);
        try {
          for (const inner of fs.readdirSync(bundle)) {
            if (inner.endsWith(".4DZ") || inner.endsWith(".4dz")) {
              out.push(path.join(bundle, inner));
            }
          }
        } catch {/* skip */}
      }
    } catch {/* ignore */}
  };
  harvest(path.join(projectRoot, "Components"));
  for (const root of findBundledComponentRoots()) harvest(root);
  return out;
}

/**
 * Augment a `ParsedFile`'s ProjectMethod symbols with parameter-type info
 * from the project's Compiler_*.4dm declarations. Mutates `params[]` on
 * each ProjectMethod / CompilerMethod symbol when a matching declaration
 * exists, appending a variadic sentinel when the Compiler_* file uses
 * `${N}` notation.
 */
function augmentVariadicParams(
  file: ParsedFile,
  compilerMethodTypes: Map<string, CompilerMethodTypes>,
): void {
  if (compilerMethodTypes.size === 0) return;
  for (const sym of file.symbols) {
    if (sym.kind !== SymbolKind.ProjectMethod && sym.kind !== SymbolKind.CompilerMethod) {
      continue;
    }
    const info = compilerMethodTypes.get(sym.name);
    if (!info) continue;
    const merged = mergeCompilerParamsWithDeclare(sym.params, info);
    if (merged) sym.params = merged;
    // Pick up the return type too, if the symbol didn't already know it
    // (e.g. method file has no `#DECLARE … -> …` arrow form).
    if (info.returnType && !sym.returnType) sym.returnType = info.returnType;
  }
}

/**
 * Compare two `Map<string, CompilerMethodTypes>` for semantic equality.
 * Used by `patchFiles` to decide whether a `Compiler_*.4dm` edit actually
 * changed any declared signature (vs. a comment / whitespace / `#DECLARE`
 * edit, where the variadic-params map is unaffected and we can skip the
 * full rebuild).
 */
function compilerMethodTypesEqual(
  a: Map<string, CompilerMethodTypes>,
  b: Map<string, CompilerMethodTypes>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [k, va] of a) {
    const vb = b.get(k);
    if (!vb) return false;
    if (va.returnType !== vb.returnType) return false;
    if (va.variadicFrom !== vb.variadicFrom) return false;
    if (va.variadicType !== vb.variadicType) return false;
    if (va.paramTypes.size !== vb.paramTypes.size) return false;
    for (const [pos, t] of va.paramTypes) {
      if (vb.paramTypes.get(pos) !== t) return false;
    }
  }
  return true;
}
