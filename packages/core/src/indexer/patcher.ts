import { CallEdge, RawCallSite, SymbolIndex, SymbolKind, SymbolRecord } from "../model/symbol";
import { CallGraph } from "../model/callGraph";
import { ParsedFile } from "./fileParser";
import {
  ResolverInput,
  ResolverScratch,
  addSymbolToScratch,
  removeSymbolFromScratch,
  resolveCallsForFile
} from "./nameResolver";
import { CompilerMethodTypes, mergeCompilerParamsWithDeclare } from "./compilerMethodScanner";

/**
 * Reverse-name index entry for cross-file invalidation. Each entry remembers
 * the source file + the index into that file's rawCalls so the patch path can
 * re-resolve the exact call site when a referenced name changes.
 */
export interface NameKeyEntry {
  fromPath: string;
  rawCallIdx: number;
  edge: CallEdge;
  nameKey: string;
}

/**
 * Everything the incremental patch path mutates, bundled explicitly so the
 * per-file operations are plain functions over one state object rather than
 * methods scattered across the Indexer. Built by the Indexer at the tail of
 * every rebuild (`populateWarmCaches`); absent (undefined on the Indexer)
 * after a cache-only `load()`, which makes the first patch bail to rebuild.
 */
export interface PatchState {
  graph: CallGraph;
  index: SymbolIndex;
  parsedByPath: Map<string, ParsedFile>;
  symbolIdsByPath: Map<string, Set<string>>;
  synthOwnersByPath: Map<string, Set<string>>;
  edgesByFromId: Map<string, CallEdge[]>;
  edgesByNameKey: Map<string, NameKeyEntry[]>;
  /**
   * Reverse map of `edgesByNameKey`: for each source file, the set of name
   * keys it has (or once had) entries under. Lets `dropNameKeyEntriesForFile`
   * filter only that file's buckets instead of scanning every bucket in the
   * project (~30k on large projects) on every save. Maintained as a superset
   * — keys are added when entries are pushed and the whole set is dropped
   * when the file's contribution is removed; an over-listed key just makes
   * the per-bucket filter a no-op.
   */
  nameKeysByPath: Map<string, Set<string>>;
  resolverInput: ResolverInput;
  constantsSet: Set<string>;
  /**
   * Long-lived resolver scratch, built once per rebuild and maintained in
   * lock-step with the graph by {@link patchAddSymbol} /
   * {@link patchRemoveSymbols}. Replaces the previous behavior of building a
   * fresh O(all-symbols) scratch once per patched file plus once per fan-out
   * — the dominant cost of a save on large projects. Each patch scope calls
   * `scratch.resetSession()` so per-session synth state matches what a fresh
   * scratch would have seen.
   */
  scratch: ResolverScratch;
}

/**
 * Insert a symbol into the live graph AND the persistent scratch, keeping the
 * two in lock-step. Mirrors `CallGraph.addSymbol`'s no-op on an already-known
 * id (two files can legally declare the same project-method name → same id;
 * the graph keeps the first record, so the scratch must too).
 *
 * ALL symbol insertion in the patch path must go through here — updating one
 * side and not the other is exactly the drift the synth-refcount invariant
 * exists to catch.
 */
function patchAddSymbol(state: PatchState, s: SymbolRecord): void {
  if (state.graph.symbol(s.id)) return;
  state.graph.addSymbol(s);
  addSymbolToScratch(state.scratch, s);
}

/** Remove symbols from the live graph AND the persistent scratch in lock-step. */
function patchRemoveSymbols(state: PatchState, ids: Iterable<string>): void {
  for (const id of ids) {
    const sym = state.graph.symbol(id);
    if (sym) removeSymbolFromScratch(state.scratch, sym);
  }
  state.graph.removeSymbolsByIds(ids);
}

/**
 * Drop everything a single `.4dm` file contributed to the live index:
 * its file-owned symbols, the edges originating from them, and any
 * synth-symbol refcount it held. Returns the set of public-name keys
 * that file previously published (so the patch path can decide which
 * cross-file edges might now need re-resolution).
 */
export function removeFileContribution(state: PatchState, absolutePath: string): Set<string> {
  const removedNameKeys = new Set<string>();
  const oldParsed = state.parsedByPath.get(absolutePath);
  const oldSyms = state.symbolIdsByPath.get(absolutePath) ?? new Set<string>();
  const oldSynths = state.synthOwnersByPath.get(absolutePath) ?? new Set<string>();

  // Track public names this file previously published — caller may need
  // them to decide whether cross-file edges need re-resolution.
  if (oldParsed) {
    for (const s of oldParsed.symbols) {
      removedNameKeys.add(s.name.toLowerCase());
      if (s.ownerClass) removedNameKeys.add(`${s.ownerClass}.${s.name}`.toLowerCase());
    }
    // Drop the file's resolver-input overlays (a 4D class is one file, so its
    // property/return-type maps come solely from here). Without this, deleted
    // properties kept resolving through stale chain-walk metadata; a re-add
    // sets fresh maps in addFileContribution.
    if (oldParsed.classInfo) {
      const key = oldParsed.classInfo.name.toLowerCase();
      state.resolverInput.projectClassPropsByName?.delete(key);
      state.resolverInput.projectClassMethodReturnsByName?.delete(key);
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
    patchRemoveSymbols(state, oldSyms);
    for (const id of oldSyms) state.edgesByFromId.delete(id);
  }
  dropNameKeyEntriesForFile(state, absolutePath);

  // Synth refcount: decrement each synth this file owned. If a synth's
  // refcount drops to zero, remove the symbol entirely.
  for (const synthId of oldSynths) {
    const sym = state.graph.symbol(synthId);
    if (!sym?.fileOrigins) continue;
    const next = sym.fileOrigins.filter((p) => p !== absolutePath);
    if (next.length === 0) {
      patchRemoveSymbols(state, [synthId]);
      state.edgesByFromId.delete(synthId);
    } else {
      sym.fileOrigins = next;
    }
  }
  state.synthOwnersByPath.delete(absolutePath);

  state.parsedByPath.delete(absolutePath);
  state.symbolIdsByPath.delete(absolutePath);

  return removedNameKeys;
}

/**
 * Drop every `edgesByNameKey` entry whose `fromPath` matches the given
 * file. Used during `removeFileContribution` so name-key lookups don't
 * surface stale entries pointing at a removed rawCall. Touches only the
 * buckets the reverse map says this file contributed to — previously this
 * scanned every bucket in the project on each patched file.
 */
function dropNameKeyEntriesForFile(state: PatchState, absolutePath: string): void {
  const keys = state.nameKeysByPath.get(absolutePath);
  if (!keys) return;
  for (const key of keys) {
    const entries = state.edgesByNameKey.get(key);
    if (!entries) continue;
    const filtered = entries.filter((e) => e.fromPath !== absolutePath);
    if (filtered.length === 0) state.edgesByNameKey.delete(key);
    else if (filtered.length !== entries.length) state.edgesByNameKey.set(key, filtered);
  }
  state.nameKeysByPath.delete(absolutePath);
}

/** Register a name-key entry in both the bucket map and the per-file reverse map. */
function pushNameKeyEntry(state: PatchState, key: string, entry: NameKeyEntry): void {
  let list = state.edgesByNameKey.get(key);
  if (!list) { list = []; state.edgesByNameKey.set(key, list); }
  list.push(entry);
  let keys = state.nameKeysByPath.get(entry.fromPath);
  if (!keys) { keys = new Set(); state.nameKeysByPath.set(entry.fromPath, keys); }
  keys.add(key);
}

/**
 * Append an edge to the live graph + `edgesByFromId`, skipping it if an
 * identical edge (same target, line, callKind, column) is already present
 * for this source symbol. Returns true if the edge was newly added.
 *
 * The cold-rebuild path dedups edges in `resolve()`, but the incremental
 * patch path appended unconditionally — so if a file's `addFileContribution`
 * ran without a preceding `removeFileContribution` purge (e.g. a create
 * event, or an add replayed across patch batches) every call site's edge
 * doubled in the persisted index. Deduping on append makes the patch path
 * idempotent and keeps the in-memory graph consistent with a cold rebuild.
 */
function appendEdgeDeduped(state: PatchState, e: CallEdge): boolean {
  let list = state.edgesByFromId.get(e.fromId);
  if (!list) { list = []; state.edgesByFromId.set(e.fromId, list); }
  if (
    list.some(
      (x) =>
        x.toId === e.toId &&
        x.line === e.line &&
        x.callKind === e.callKind &&
        x.column === e.column &&
        x.access === e.access
    )
  ) {
    return false;
  }
  state.graph.addEdge(e);
  list.push(e);
  return true;
}

/**
 * Add a freshly-parsed file's contribution to the live index: insert its
 * symbols, then re-resolve its rawCalls against the current global symbol
 * table and add the resulting edges. Returns the file's published
 * public-name keys (a superset of what the caller will diff against the
 * pre-removal set for cross-file invalidation).
 */
export function addFileContribution(state: PatchState, parsed: ParsedFile): Set<string> {
  const added = new Set<string>();

  const fp = parsed.file.absolutePath;
  const newIds = new Set<string>();
  for (const s of parsed.symbols) {
    patchAddSymbol(state, s);
    newIds.add(s.id);
    added.add(s.name.toLowerCase());
    if (s.ownerClass) added.add(`${s.ownerClass}.${s.name}`.toLowerCase());
  }
  state.symbolIdsByPath.set(fp, newIds);
  state.parsedByPath.set(fp, parsed);

  // Update resolverInput's per-file overlays for project classes. The
  // resolver consults `projectClassPropsByName` / `projectClassMethodReturnsByName`
  // when walking $x.foo.bar chains, so they must reflect the current file
  // before we re-resolve any calls.
  if (parsed.classInfo) {
    const key = parsed.classInfo.name.toLowerCase();
    // Replace (not merge) the class's overlays: the class lives in this one
    // file, so the fresh parse is the complete truth. Merging let removed
    // properties/methods linger in the chain-walk metadata forever.
    if (parsed.classPropertyTypes) {
      state.resolverInput.projectClassPropsByName?.set(key, new Map(parsed.classPropertyTypes));
    }
    if (parsed.classMethodReturnsByName) {
      state.resolverInput.projectClassMethodReturnsByName?.set(key, new Map(parsed.classMethodReturnsByName));
    }
  }

  // Resolve just this file's calls against the persistent scratch. The
  // session reset clears synth state so `scratch.unresolved` only collects
  // THIS scope's synths (the fileOrigins merge below depends on that); the
  // lookup tables stay warm — they were maintained in lock-step as symbols
  // were removed/added above. The scratch's setCurrentFileOrigin attributes
  // any new synth symbols to this file.
  const scratch = state.scratch;
  scratch.resetSession();
  const newEdges = resolveCallsForFile(parsed, scratch);

  // Merge any synth symbols the resolver created during this patch into
  // the live index. (The session reset starts with an empty `unresolved`,
  // so this list only contains synths the current file created — or that
  // existed before but got re-created because the session was fresh. We
  // dedup against the graph's existing symbols by id.)
  for (const u of scratch.unresolved) {
    const existing = state.graph.symbol(u.id);
    if (existing) {
      // Carry over the new fileOrigins entries (recordSynthOwner already set
      // u.fileOrigins to [fp]).
      const next = existing.fileOrigins ?? [];
      if (!next.includes(fp)) next.push(fp);
      existing.fileOrigins = next;
    } else {
      patchAddSymbol(state, u);
    }
  }
  // Merge synthOwnersByPath: for incremental builds, the scratch tracks just
  // this patch's synths under `fp`.
  const synths = scratch.synthOwnersByPath.get(fp);
  if (synths) {
    let existing = state.synthOwnersByPath.get(fp);
    if (!existing) { existing = new Set(); state.synthOwnersByPath.set(fp, existing); }
    for (const id of synths) existing.add(id);
  }

  // Append edges to the live index + maintain edgesByFromId and edgesByNameKey.
  // Dedup on append so a replayed add can't double a call site's edge.
  const addedEdges = new Set<CallEdge>();
  for (const e of newEdges) {
    if (appendEdgeDeduped(state, e)) addedEdges.add(e);
  }
  // Reverse-name index for the new edges (only those actually added — a
  // skipped duplicate's name-key entry already exists from the first add).
  for (let i = 0; i < parsed.rawCalls.length; i++) {
    const call = parsed.rawCalls[i];
    if (!call.hint) continue;
    const keys = nameKeysForHint(call.hint);
    if (keys.length === 0) continue;
    const edge = newEdges.find(
      (e) => e.fromId === call.fromSymbolId && e.line === call.line && e.raw === call.expression && e.column === call.column
    );
    if (!edge || !addedEdges.has(edge)) continue;
    for (const k of keys) {
      pushNameKeyEntry(state, k, { fromPath: fp, rawCallIdx: i, edge, nameKey: k });
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
export function reresolveAffectedDependents(
  state: PatchState,
  affectedNameKeys: Set<string>,
  changedPaths: Set<string>
): number {
  if (affectedNameKeys.size === 0) return 0;

  // Collect unique (fromPath, rawCallIdx) pairs from all affected name
  // keys. The same rawCall is indexed under multiple keys (e.g. CsCall
  // by both className AND method) so we dedup to re-resolve once per
  // call site.
  const toResolve = new Map<string, { fromPath: string; rawCallIdx: number }>();
  for (const key of affectedNameKeys) {
    const entries = state.edgesByNameKey.get(key);
    if (!entries) continue;
    for (const entry of entries) {
      if (changedPaths.has(entry.fromPath)) continue;
      const dedupKey = `${entry.fromPath}|${entry.rawCallIdx}`;
      if (!toResolve.has(dedupKey)) toResolve.set(dedupKey, { fromPath: entry.fromPath, rawCallIdx: entry.rawCallIdx });
    }
  }
  if (toResolve.size === 0) return 0;

  // Reuse the persistent scratch for every affected call site, with a fresh
  // synth session so `scratch.unresolved` only collects this fan-out's synths.
  const scratch = state.scratch;
  scratch.resetSession();

  // Group the affected calls by file so we can build mini-ParsedFile
  // clones (each with one rawCall) and call resolveCallsForFile.
  const byFile = new Map<string, Array<{ rawCallIdx: number }>>();
  for (const { fromPath, rawCallIdx } of toResolve.values()) {
    let list = byFile.get(fromPath);
    if (!list) { list = []; byFile.set(fromPath, list); }
    list.push({ rawCallIdx });
  }

  for (const [fromPath, items] of byFile) {
    const parsed = state.parsedByPath.get(fromPath);
    if (!parsed) continue;
    for (const { rawCallIdx } of items) {
      const call = parsed.rawCalls[rawCallIdx];
      if (!call?.hint) continue;
      const keys = nameKeysForHint(call.hint);

      // Find and remove the existing edge for this rawCall.
      const candidates = state.edgesByFromId.get(call.fromSymbolId) ?? [];
      const oldEdge = candidates.find(
        (e) => e.line === call.line && e.raw === call.expression && e.column === call.column
      );
      if (oldEdge) {
        state.graph.removeEdge(oldEdge);
        // Remove from edgesByFromId
        const list = state.edgesByFromId.get(call.fromSymbolId);
        if (list) {
          const i = list.indexOf(oldEdge);
          if (i >= 0) list.splice(i, 1);
          if (list.length === 0) state.edgesByFromId.delete(call.fromSymbolId);
        }
        // Drop the edge's entries from edgesByNameKey, but only in the
        // buckets this rawCall actually published — `keys` is small (1–2
        // names from `nameKeysForHint`). The general `dropNameKeyEntriesForFile`
        // would scan all ~30k buckets per edge and dominate the fan-out cost.
        for (const k of keys) {
          const bucket = state.edgesByNameKey.get(k);
          if (!bucket) continue;
          const filtered = bucket.filter((entry) => entry.edge !== oldEdge);
          if (filtered.length === 0) state.edgesByNameKey.delete(k);
          else if (filtered.length !== bucket.length) state.edgesByNameKey.set(k, filtered);
        }
        // The old edge may have targeted a synth — decrement the synth's
        // refcount via the calling file. If we owned the only reference,
        // the synth is now orphaned; let the graph drop it.
        decrementSynthRef(state, oldEdge.toId, fromPath);
      }

      // Re-resolve this single rawCall against the fresh scratch.
      const miniParsed = { ...parsed, rawCalls: [call] };
      const newEdges = resolveCallsForFile(miniParsed, scratch);
      for (const e of newEdges) {
        if (!appendEdgeDeduped(state, e)) continue;
        for (const k of keys) {
          pushNameKeyEntry(state, k, { fromPath, rawCallIdx, edge: e, nameKey: k });
        }
      }
    }
  }

  // Merge any new synth symbols the re-resolution produced.
  for (const u of scratch.unresolved) {
    const existing = state.graph.symbol(u.id);
    if (existing) {
      // Carry over any new fileOrigins entries the scratch recorded.
      const next = existing.fileOrigins ?? [];
      for (const origin of u.fileOrigins ?? []) {
        if (!next.includes(origin)) next.push(origin);
      }
      existing.fileOrigins = next;
    } else {
      patchAddSymbol(state, u);
    }
  }
  // Merge synthOwnersByPath: scratch tracked synths per file during this
  // fan-out; fold those into the live map.
  for (const [origin, ids] of scratch.synthOwnersByPath) {
    let existing = state.synthOwnersByPath.get(origin);
    if (!existing) { existing = new Set(); state.synthOwnersByPath.set(origin, existing); }
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
function decrementSynthRef(state: PatchState, synthId: string, fromPath: string): void {
  const sym = state.graph.symbol(synthId);
  if (!sym?.fileOrigins) return; // not a synth (or no tracking)
  const next = sym.fileOrigins.filter((p) => p !== fromPath);
  const owners = state.synthOwnersByPath.get(fromPath);
  if (owners) owners.delete(synthId);
  if (next.length === 0) {
    patchRemoveSymbols(state, [synthId]);
    state.edgesByFromId.delete(synthId);
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
export function assertSynthRefcountInvariant(state: PatchState): boolean {
  let ownersTotal = 0;
  for (const owners of state.synthOwnersByPath.values()) ownersTotal += owners.size;
  let originsTotal = 0;
  for (const s of state.graph.allSymbols()) {
    if (s.kind === SymbolKind.Builtin || s.kind === SymbolKind.TableBuiltin || s.kind === SymbolKind.Unresolved) {
      originsTotal += s.fileOrigins?.length ?? 0;
    }
  }
  return ownersTotal === originsTotal;
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
export function nameKeysForHint(hint: NonNullable<RawCallSite["hint"]>): string[] {
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
    case "CsChainCall":
      return [lc(hint.className), lc(hint.method)];
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
 * Augment a `ParsedFile`'s ProjectMethod symbols with parameter-type info
 * from the project's Compiler_*.4dm declarations. Mutates `params[]` on
 * each ProjectMethod / CompilerMethod symbol when a matching declaration
 * exists, appending a variadic sentinel when the Compiler_* file uses
 * `${N}` notation.
 */
export function augmentVariadicParams(
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
export function compilerMethodTypesEqual(
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
