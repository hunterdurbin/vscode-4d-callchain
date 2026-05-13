import { CallEdge, SymbolIndex, SymbolRecord } from "./symbol";

export class CallGraph {
  private readonly symbolsById = new Map<string, SymbolRecord>();
  private readonly symbolsByName = new Map<string, SymbolRecord[]>();
  private readonly forward = new Map<string, CallEdge[]>();
  private readonly reverse = new Map<string, CallEdge[]>();

  constructor(private readonly index: SymbolIndex) {
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
}
