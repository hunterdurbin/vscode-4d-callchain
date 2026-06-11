import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { pack } from "msgpackr";
import { SymbolIndex } from "../model/symbol";
import { Logger } from "../util/logger";
import { findBundledComponentRoots } from "./componentScanner";

// Binary msgpack file — 3–5× faster to encode and ~2× smaller than the old
// JSON cache. Pre-v29 caches used `callchain-index.json`; those are simply
// ignored (load() falls through to `rebuild()` when neither file is fresh).
// The filename is suffixed with a short hash of the absolute project root
// so two projects sharing the same `.vscode/` directory (multi-root
// workspaces, sibling project subfolders) don't trample each other's caches.
const INDEX_FILENAME_PREFIX = "callchain-index";
const INDEX_FILENAME_SUFFIX = ".msgpack";

export function cacheFileNameFor(projectRoot: string): string {
  const canonical = path.resolve(projectRoot);
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  return `${INDEX_FILENAME_PREFIX}-${hash}${INDEX_FILENAME_SUFFIX}`;
}

export interface PersistenceOptions {
  projectRoot: string;
  logger: Logger;
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

/**
 * Owns the on-disk msgpack cache: path derivation, freshness validation,
 * and (debounced) writes. The cache is only consulted at the next process
 * start; correctness during the running session relies on the in-memory
 * index held by the Indexer.
 */
export class IndexPersistence {
  private pendingPersist: ReturnType<typeof setTimeout> | undefined;
  private inFlightPersist: Promise<void> | undefined;

  constructor(private readonly opts: PersistenceOptions) {}

  indexPath(): string {
    const dir = this.opts.cacheDir ?? path.join(this.opts.projectRoot, ".vscode");
    return path.join(dir, cacheFileNameFor(this.opts.projectRoot));
  }

  /** Resolves when the most recently started async cache write has landed. */
  whenWriteSettles(): Promise<void> {
    return this.inFlightPersist ?? Promise.resolve();
  }

  persist(idx: SymbolIndex): void {
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
  schedulePersist(idx: SymbolIndex): void {
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
  async flushPersist(current: SymbolIndex | undefined): Promise<void> {
    if (this.pendingPersist) {
      clearTimeout(this.pendingPersist);
      this.pendingPersist = undefined;
      if (current) this.persist(current);
    }
    if (this.inFlightPersist) await this.inFlightPersist;
  }

  async isFresh(raw: SymbolIndex): Promise<boolean> {
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
