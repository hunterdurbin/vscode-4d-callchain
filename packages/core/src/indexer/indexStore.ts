import * as fs from "fs";
import * as path from "path";
import { CallEdge, INDEX_VERSION, RawCallSite, SymbolIndex, SymbolKind, SymbolRecord } from "../model/symbol";
import { CallGraph } from "../model/callGraph";
import { Logger } from "../util/logger";
import { TypedEmitter } from "../util/emitter";
import { discoverCatalogTableIdMap, discoverCatalogTables, discoverFiles, discoverPlugins } from "./projectScanner";
import { DEFAULT_BUILTIN_CONSTANTS_PROBES, discoverBuiltinConstants, discoverConstants } from "./constantsScanner";
import { discoverVariables } from "./variableScanner";
import { discoverComponents } from "./componentScanner";
import { ParsedFile, parseFile } from "./fileParser";
import { buildResolverScratch, buildSymbolIndex, resolveCallsForFile, ResolverInput } from "./nameResolver";
import { classifyFile } from "./projectScanner";

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

const INDEX_FILENAME = "callchain-index.json";

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
  private pendingPersist: ReturnType<typeof setTimeout> | undefined;

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
          this.opts.logger.info(`[Indexer] Loaded cached index (${raw.symbols.length} symbols, ${raw.edges.length} edges)`);
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
    const start = Date.now();
    this.opts.logger.info(`[Indexer] Scanning ${this.opts.projectRoot}`);
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
    // Bare-identifier lookup set: constants + process variables. Interprocess
    // variables are matched via the `<>name` regex, not the bare path. 4D is
    // case-insensitive for identifiers so the set holds lowercase entries and
    // callExtractor compares against `candidate.toLowerCase()`.
    const constantsSet = new Set<string>([
      ...constants.map((c) => c.name.toLowerCase()),
      ...builtinConstants.map((c) => c.name.toLowerCase()),
      ...variables.filter((v) => v.scope === "process").map((v) => v.name.toLowerCase())
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
        this.opts.logger.info(`[Indexer]   parsed ${i}/${files.length}`);
      }
    }
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

    const built = buildSymbolIndex(this.opts.projectRoot, parsed, plugins, catalogTables, constants, builtinConstants, variables, components);
    const idx = built.index;
    idx.fileMtimes = mtimes;

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

    this.populateWarmCaches(parsed, built.resolverInput, built.synthOwnersByPath, idx, constantsSet);
    this.persist(idx);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
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
    if (!this.currentIndex || !this.graph) return;
    if (changes.length === 0) return;

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
    if (changes.some((c) => !c.path.endsWith(".4dm"))) {
      this.opts.logger.info(`[Indexer] Non-.4dm change in batch — full rebuild`);
      await this.rebuild();
      return;
    }

    const start = Date.now();
    const affectedNameKeys = new Set<string>();
    const changedPaths = new Set(changes.map((c) => c.path));

    for (const change of changes) {
      const exists = fs.existsSync(change.path);
      const effective: "change" | "delete" = !exists ? "delete" : (change.kind === "delete" ? "delete" : "change");

      // Remove the file's old contribution (if any).
      const oldKeys = this.removeFileContribution(change.path);
      for (const k of oldKeys) affectedNameKeys.add(k);

      if (effective === "delete") {
        delete this.currentIndex.fileMtimes[change.path];
        continue;
      }

      // Re-parse and merge.
      const discovered = classifyFile(change.path, this.opts.projectRoot);
      if (!discovered) {
        // Not a recognized source file — nothing to add. Old contribution
        // already removed above.
        continue;
      }
      const parsed = parseFile(discovered, this.opts.projectRoot, this.constantsSet);
      try { this.currentIndex.fileMtimes[change.path] = fs.statSync(change.path).mtimeMs; } catch {/* skip */}

      const newKeys = this.addFileContribution(parsed);
      for (const k of newKeys) affectedNameKeys.add(k);
    }

    this.reresolveAffectedDependents(affectedNameKeys, changedPaths);

    if (!this.assertSynthRefcountInvariant()) {
      this.opts.logger.warn(`[Indexer] Synth refcount drift detected — falling back to full rebuild`);
      await this.rebuild();
      return;
    }

    this.schedulePersist(this.currentIndex);
    const elapsed = Date.now() - start;
    this.opts.logger.info(`[Indexer] Patched ${changes.length} file(s) in ${elapsed}ms`);
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
    // Also drops edges that target file-owned symbols (incoming edges).
    if (oldSyms.size > 0) {
      const { removedEdges } = this.graph.removeSymbolsByIds(oldSyms);
      // edgesByFromId: drop any entry whose key is in oldSyms; also remove
      // each removed edge from its `from` bucket if the `from` survives.
      for (const id of oldSyms) this.edgesByFromId.delete(id);
      // edgesByNameKey: drop any entry produced by this file (we re-add only
      // entries that survive — concrete edges may have been removed above).
      this.dropNameKeyEntriesForFile(absolutePath);
      // Drop any references in name-key entries whose edge was removed.
      for (const e of removedEdges) this.dropEdgeFromNameKeyIndex(e);
    } else {
      this.dropNameKeyEntriesForFile(absolutePath);
    }

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
   * Drop any name-key entries that reference the given edge by identity.
   * Used after `CallGraph.removeSymbolsByIds` removes incoming edges from
   * other files (their nameKey buckets are otherwise unaware).
   */
  private dropEdgeFromNameKeyIndex(edge: CallEdge): void {
    if (!this.edgesByNameKey) return;
    for (const [key, entries] of this.edgesByNameKey) {
      const filtered = entries.filter((e) => e.edge !== edge);
      if (filtered.length === 0) this.edgesByNameKey.delete(key);
      else if (filtered.length !== entries.length) this.edgesByNameKey.set(key, filtered);
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
  private reresolveAffectedDependents(affectedNameKeys: Set<string>, changedPaths: Set<string>): void {
    if (affectedNameKeys.size === 0) return;
    if (!this.parsedByPath || !this.symbolIdsByPath || !this.synthOwnersByPath
        || !this.edgesByFromId || !this.edgesByNameKey || !this.graph
        || !this.currentIndex || !this.resolverInput) return;

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
    if (toResolve.size === 0) return;

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
          this.dropEdgeFromNameKeyIndex(oldEdge);
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
    const dir = this.opts.cacheDir ?? path.join(this.opts.projectRoot, ".vscode");
    return path.join(dir, INDEX_FILENAME);
  }

  private persist(idx: SymbolIndex): void {
    try {
      const dir = path.dirname(this.indexPath());
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.indexPath(), JSON.stringify(idx));
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
   * Force any pending debounced persist to run immediately. Call before
   * process exit to make sure the on-disk cache reflects the latest patch.
   */
  flushPersist(): void {
    if (!this.pendingPersist || !this.currentIndex) return;
    clearTimeout(this.pendingPersist);
    this.pendingPersist = undefined;
    this.persist(this.currentIndex);
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
