import { CallEdge, SymbolIndex, SymbolRecord } from "./symbol";

export class CallGraph {
  private readonly symbolsById = new Map<string, SymbolRecord>();
  private readonly symbolsByName = new Map<string, SymbolRecord[]>();
  private readonly forward = new Map<string, CallEdge[]>();
  private readonly reverse = new Map<string, CallEdge[]>();

  constructor(private index: SymbolIndex) {
    for (const s of index.symbols) {
      this.symbolsById.set(s.id, s);
      const key = s.name.toLowerCase();
      const list = this.symbolsByName.get(key) ?? [];
      list.push(s);
      this.symbolsByName.set(key, list);
    }
    for (const e of index.edges) {
      const f = this.forward.get(e.fromId) ?? [];
      f.push(e);
      this.forward.set(e.fromId, f);
      const r = this.reverse.get(e.toId) ?? [];
      r.push(e);
      this.reverse.set(e.toId, r);
    }
  }

  get root(): SymbolIndex {
    return this.index;
  }

  symbol(id: string): SymbolRecord | undefined {
    return this.symbolsById.get(id);
  }

  byName(name: string): SymbolRecord[] {
    return this.symbolsByName.get(name.toLowerCase()) ?? [];
  }

  allSymbols(): SymbolRecord[] {
    return this.index.symbols;
  }

  callees(id: string): CallEdge[] {
    return this.forward.get(id) ?? [];
  }

  callers(id: string): CallEdge[] {
    return this.reverse.get(id) ?? [];
  }

  /** BFS reachable set bounded by depth. */
  reachable(id: string, depth: number, direction: "forward" | "reverse" | "both"): { nodes: Set<string>; edges: CallEdge[] } {
    const nodes = new Set<string>([id]);
    const edges: CallEdge[] = [];
    let frontier: string[] = [id];
    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        if (direction === "forward" || direction === "both") {
          for (const e of this.callees(cur)) {
            edges.push(e);
            if (!nodes.has(e.toId)) {
              nodes.add(e.toId);
              next.push(e.toId);
            }
          }
        }
        if (direction === "reverse" || direction === "both") {
          for (const e of this.callers(cur)) {
            edges.push(e);
            if (!nodes.has(e.fromId)) {
              nodes.add(e.fromId);
              next.push(e.fromId);
            }
          }
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    return { nodes, edges };
  }

  /**
   * Shortest call path between two symbols as the ordered list of edges that
   * connect `fromId` to `toId`, or `null` if none exists within `maxDepth`
   * hops. A BFS with a parent map (mirrors `reachable`'s traversal); the first
   * time `toId` is dequeued the path is minimal in hop count.
   *
   * `direction` controls which edges are followed:
   *   - "forward": follow callees (does `from` reach `to` by calling?)
   *   - "reverse": follow callers (does `to` reach `from` by calling?)
   *   - "both": treat the graph as undirected.
   */
  shortestPath(
    fromId: string,
    toId: string,
    maxDepth: number,
    direction: "forward" | "reverse" | "both" = "forward"
  ): CallEdge[] | null {
    if (fromId === toId) return [];
    if (!this.symbolsById.has(fromId) || !this.symbolsById.has(toId)) return null;

    // For each visited node, the edge we arrived by (to reconstruct the path).
    const cameBy = new Map<string, CallEdge>();
    const visited = new Set<string>([fromId]);
    let frontier: string[] = [fromId];

    for (let d = 0; d < maxDepth && frontier.length; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        const step = (neighborId: string, edge: CallEdge): boolean => {
          if (visited.has(neighborId)) return false;
          visited.add(neighborId);
          cameBy.set(neighborId, edge);
          if (neighborId === toId) return true;
          next.push(neighborId);
          return false;
        };
        if (direction === "forward" || direction === "both") {
          for (const e of this.callees(cur)) {
            if (step(e.toId, e)) return this.reconstructPath(cameBy, toId);
          }
        }
        if (direction === "reverse" || direction === "both") {
          for (const e of this.callers(cur)) {
            if (step(e.fromId, e)) return this.reconstructPath(cameBy, toId);
          }
        }
      }
      frontier = next;
    }
    return null;
  }

  /** Walk the `cameBy` parent map back from `toId` to produce edges in order. */
  private reconstructPath(cameBy: Map<string, CallEdge>, toId: string): CallEdge[] {
    const path: CallEdge[] = [];
    let cur = toId;
    let edge = cameBy.get(cur);
    while (edge) {
      path.push(edge);
      // The other endpoint of this edge relative to `cur` is its predecessor.
      cur = edge.toId === cur ? edge.fromId : edge.toId;
      edge = cameBy.get(cur);
    }
    return path.reverse();
  }

  /** All forward-reachable symbol ids starting from any of seeds. */
  forwardClosure(seeds: Iterable<string>): Set<string> {
    const visited = new Set<string>();
    const stack: string[] = [];
    for (const s of seeds) {
      if (!visited.has(s)) {
        visited.add(s);
        stack.push(s);
      }
    }
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of this.callees(cur)) {
        if (!visited.has(e.toId)) {
          visited.add(e.toId);
          stack.push(e.toId);
        }
      }
    }
    return visited;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Mutation API
  //
  // Incremental indexing edits the live graph rather than rebuilding from
  // scratch. All mutators keep the underlying `SymbolIndex.symbols`/`edges`
  // arrays in sync with the lookup maps so downstream consumers reading
  // `graph.root` / `graph.allSymbols()` see consistent state.
  // ──────────────────────────────────────────────────────────────────────

  addSymbol(s: SymbolRecord): void {
    if (this.symbolsById.has(s.id)) return;
    this.symbolsById.set(s.id, s);
    this.index.symbols.push(s);
    const key = s.name.toLowerCase();
    const list = this.symbolsByName.get(key) ?? [];
    list.push(s);
    this.symbolsByName.set(key, list);
  }

  /**
   * Remove the given symbols + their outgoing edges. Incoming edges (those
   * targeting a removed symbol) are left in place: the incremental indexer's
   * cross-file fan-out step is responsible for re-resolving them once it
   * knows whether the removal was part of a file change (same id may be
   * added back) or a true delete. Pass `{ alsoRemoveIncoming: true }` to opt
   * into removing incoming edges too — used by callers that know the
   * removal is final.
   */
  removeSymbolsByIds(ids: Iterable<string>, opts?: { alsoRemoveIncoming?: boolean }): { removedEdges: CallEdge[] } {
    const idSet = ids instanceof Set ? (ids as Set<string>) : new Set(ids);
    if (idSet.size === 0) return { removedEdges: [] };
    const alsoIncoming = opts?.alsoRemoveIncoming === true;

    // Remove from name buckets first so we can iterate symbolsById.
    for (const id of idSet) {
      const sym = this.symbolsById.get(id);
      if (!sym) continue;
      const key = sym.name.toLowerCase();
      const list = this.symbolsByName.get(key);
      if (list) {
        const next = list.filter((s) => s.id !== id);
        if (next.length === 0) this.symbolsByName.delete(key);
        else this.symbolsByName.set(key, next);
      }
      this.symbolsById.delete(id);
    }

    this.index.symbols = this.index.symbols.filter((s) => !idSet.has(s.id));

    // Drop edges originating from a removed symbol (always). If
    // alsoRemoveIncoming is set, also drop edges that target a removed
    // symbol; otherwise leave the incoming edges in place so a follow-up
    // fan-out step can decide what to do with them.
    const removed: CallEdge[] = [];
    const kept: CallEdge[] = [];
    for (const e of this.index.edges) {
      const drop = idSet.has(e.fromId) || (alsoIncoming && idSet.has(e.toId));
      if (drop) removed.push(e);
      else kept.push(e);
    }
    this.index.edges = kept;

    // Rebuild forward/reverse buckets touched by removed edges. Iterating
    // every bucket is O(edges) worst case; in practice the touched bucket
    // count is small so we only filter the affected ones.
    const touchedFrom = new Set<string>();
    const touchedTo = new Set<string>();
    for (const e of removed) {
      touchedFrom.add(e.fromId);
      touchedTo.add(e.toId);
    }
    for (const id of touchedFrom) {
      if (idSet.has(id)) {
        this.forward.delete(id);
      } else {
        const list = this.forward.get(id);
        if (list) {
          const next = alsoIncoming
            ? list.filter((e) => !idSet.has(e.toId))
            : list;
          if (next.length === 0) this.forward.delete(id);
          else this.forward.set(id, next);
        }
      }
    }
    for (const id of touchedTo) {
      if (idSet.has(id)) {
        this.reverse.delete(id);
      } else {
        const list = this.reverse.get(id);
        if (list) {
          const next = list.filter((e) => !idSet.has(e.fromId));
          if (next.length === 0) this.reverse.delete(id);
          else this.reverse.set(id, next);
        }
      }
    }

    return { removedEdges: removed };
  }

  addEdge(e: CallEdge): void {
    this.index.edges.push(e);
    const f = this.forward.get(e.fromId) ?? [];
    f.push(e);
    this.forward.set(e.fromId, f);
    const r = this.reverse.get(e.toId) ?? [];
    r.push(e);
    this.reverse.set(e.toId, r);
  }

  /**
   * Remove a single edge identified by object identity. Used by the cross-file
   * fan-out path that needs to re-resolve a specific call site. O(edges) splice
   * — bounded by the count of call sites touching a renamed/removed name.
   */
  removeEdge(e: CallEdge): void {
    const idx = this.index.edges.indexOf(e);
    if (idx >= 0) this.index.edges.splice(idx, 1);
    const f = this.forward.get(e.fromId);
    if (f) {
      const fi = f.indexOf(e);
      if (fi >= 0) f.splice(fi, 1);
      if (f.length === 0) this.forward.delete(e.fromId);
    }
    const r = this.reverse.get(e.toId);
    if (r) {
      const ri = r.indexOf(e);
      if (ri >= 0) r.splice(ri, 1);
      if (r.length === 0) this.reverse.delete(e.toId);
    }
  }

  /** Reattach the graph to a new SymbolIndex (used after a full rebuild that
   *  replaces the underlying index reference). */
  setIndex(idx: SymbolIndex): void {
    this.index = idx;
  }

  /** All reverse-reachable symbol ids: seeds + anything that can reach them. */
  reverseClosure(seeds: Iterable<string>): Set<string> {
    const visited = new Set<string>();
    const stack: string[] = [];
    for (const s of seeds) {
      if (!visited.has(s)) {
        visited.add(s);
        stack.push(s);
      }
    }
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of this.callers(cur)) {
        if (!visited.has(e.fromId)) {
          visited.add(e.fromId);
          stack.push(e.fromId);
        }
      }
    }
    return visited;
  }
}
