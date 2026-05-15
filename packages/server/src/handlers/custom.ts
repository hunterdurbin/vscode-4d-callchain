import { Connection, RequestType } from "vscode-languageserver/node";
import { CallEdge, SymbolRecord } from "@4d/core";
import { ServerState } from "../state";

/**
 * Custom requests under the `$/callchain/*` namespace.
 * These expose the rich CallGraph operations that don't fit the standard LSP surface —
 * mostly the bounded reachability used by the graph visualization.
 */

export interface ReachableParams {
  id: string;
  depth: number;
  direction: "forward" | "reverse" | "both";
}
export interface ReachableResult {
  nodes: SymbolRecord[];
  edges: CallEdge[];
}

export interface AllSymbolsResult {
  symbols: SymbolRecord[];
}

export interface ReindexResult {
  ok: boolean;
  message?: string;
}

const ReachableRequest = new RequestType<ReachableParams, ReachableResult, void>("$/callchain/reachable");
const AllSymbolsRequest = new RequestType<void, AllSymbolsResult, void>("$/callchain/allSymbols");
const ReindexRequest = new RequestType<void, ReindexResult, void>("$/callchain/reindex");

export function registerCustomHandlers(state: ServerState, connection: Connection): void {
  connection.onRequest(ReachableRequest, (params): ReachableResult => {
    const graph = state.graph;
    if (!graph) return { nodes: [], edges: [] };
    const { nodes: ids, edges } = graph.reachable(params.id, params.depth, params.direction);
    const nodes: SymbolRecord[] = [];
    for (const id of ids) {
      const s = graph.symbol(id);
      if (s) nodes.push(s);
    }
    return { nodes, edges };
  });

  connection.onRequest(AllSymbolsRequest, (): AllSymbolsResult => {
    const graph = state.graph;
    if (!graph) return { symbols: [] };
    return { symbols: graph.allSymbols() };
  });

  connection.onRequest(ReindexRequest, async (): Promise<ReindexResult> => {
    if (!state.indexer) return { ok: false, message: "indexer not initialized" };
    try {
      await state.indexer.rebuild();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: String(err) };
    }
  });
}
