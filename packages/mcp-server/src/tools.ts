import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphState } from "./graphState.js";
import {
  callPath,
  classHierarchy,
  classMembers,
  findCallees,
  findCallers,
  findInstantiations,
  findOverriddenQuery,
  findOverridesQuery,
  getSymbol,
  isQueryError,
  reachableQuery,
  searchSymbols
} from "./queries.js";

/** Wrap any query result as an MCP text response, flagging selector misses. */
function result(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    isError: isQueryError(data)
  };
}

/**
 * Fields for selecting a symbol. A tool takes a stable `symbolId` (from a
 * previous result) OR a `name` with optional `kind` / `ownerClass` filters to
 * disambiguate same-named symbols.
 */
const selectorShape = {
  symbolId: z.string().optional().describe("Stable symbol id from a previous result (preferred — unambiguous)."),
  name: z.string().optional().describe("Symbol name, e.g. a method or class name (case-insensitive)."),
  kind: z
    .string()
    .optional()
    .describe("Filter by SymbolKind, e.g. ProjectMethod, Class, ClassFunction, Form, Constant."),
  ownerClass: z.string().optional().describe("For class members: the owning class name, to disambiguate.")
};
const selectorObject = z.object(selectorShape);
const directionSchema = z.enum(["forward", "reverse", "both"]);

export function registerTools(server: McpServer, state: GraphState): void {
  const root = () => state.projectRoot;

  server.registerTool(
    "search_symbols",
    {
      title: "Search symbols",
      description:
        "Find 4D symbols (methods, classes, class functions, forms, constants, …) by name. " +
        "Ranks exact > prefix > fuzzy subsequence matches. Use this first to discover a symbol's id.",
      inputSchema: {
        query: z.string().describe("Name or fragment to search for."),
        kind: z.string().optional().describe("Optional SymbolKind filter (e.g. Class, ProjectMethod)."),
        limit: z.number().int().min(1).max(200).optional().describe("Max results (default 30).")
      }
    },
    async (args) => result(searchSymbols(state.getGraph(), root(), args))
  );

  server.registerTool(
    "get_symbol",
    {
      title: "Get symbol details",
      description: "Look up one symbol (by id or name) with its signature, location, and caller/callee counts.",
      inputSchema: selectorShape
    },
    async (args) => result(getSymbol(state.getGraph(), root(), args))
  );

  server.registerTool(
    "find_callers",
    {
      title: "Find callers",
      description:
        "List the symbols that call the given symbol (incoming edges), with call-site lines. " +
        "For an overriding class method, also returns `viaBase` — call sites that resolve to an " +
        "ancestor's same-named method but can dispatch here polymorphically (so the override isn't " +
        "mistaken for dead code). The direct `count` excludes these.",
      inputSchema: { ...selectorShape, limit: z.number().int().min(1).max(500).optional() }
    },
    async ({ limit, ...sel }) => result(findCallers(state.getGraph(), root(), sel, limit))
  );

  server.registerTool(
    "find_callees",
    {
      title: "Find callees",
      description: "List the symbols the given symbol calls (outgoing edges), with call-site lines.",
      inputSchema: { ...selectorShape, limit: z.number().int().min(1).max(500).optional() }
    },
    async ({ limit, ...sel }) => result(findCallees(state.getGraph(), root(), sel, limit))
  );

  server.registerTool(
    "reachable",
    {
      title: "Reachable symbols",
      description:
        "Bounded breadth-first traversal from a symbol. direction=forward follows callees, " +
        "reverse follows callers, both is undirected. Returns the reachable symbol set within depth hops.",
      inputSchema: {
        ...selectorShape,
        depth: z.number().int().min(1).max(10).optional().describe("Max hops (default 2)."),
        direction: directionSchema.optional().describe("forward | reverse | both (default forward).")
      }
    },
    async ({ depth, direction, ...sel }) =>
      result(reachableQuery(state.getGraph(), root(), sel, depth ?? 2, direction ?? "forward"))
  );

  server.registerTool(
    "call_path",
    {
      title: "Call path between two symbols",
      description:
        "Find the shortest call path between two symbols. direction=forward asks whether `from` reaches " +
        "`to` by calling; reverse follows callers; both is undirected. Returns the ordered symbol chain or found=false.",
      inputSchema: {
        from: selectorObject.describe("Source symbol selector."),
        to: selectorObject.describe("Target symbol selector."),
        maxDepth: z.number().int().min(1).max(20).optional().describe("Max hops to search (default 8)."),
        direction: directionSchema.optional().describe("forward | reverse | both (default forward).")
      }
    },
    async ({ from, to, maxDepth, direction }) =>
      result(callPath(state.getGraph(), root(), from, to, maxDepth ?? 8, direction ?? "forward"))
  );

  server.registerTool(
    "class_hierarchy",
    {
      title: "Class hierarchy",
      description:
        "For a 4D class, return its ancestors (extends chain), direct subclasses, and all transitive descendants.",
      inputSchema: { className: z.string().describe("The class name.") }
    },
    async ({ className }) => result(classHierarchy(state.getGraph(), root(), className))
  );

  server.registerTool(
    "class_members",
    {
      title: "Class members",
      description:
        "List a 4D class's API without reading the .4dm file. Returns the class's own members " +
        "(constructor, functions, getters/setters, aliases) with kind, scope (local/shared/public), " +
        "accessor role, line numbers, and caller/callee counts; own members that override an ancestor " +
        "carry an `overrides` link. Also returns `inherited` — function members visible from ancestor " +
        "classes that aren't shadowed locally.",
      inputSchema: { className: z.string().describe("The class name.") }
    },
    async ({ className }) => result(classMembers(state.getGraph(), root(), className))
  );

  server.registerTool(
    "find_instantiations",
    {
      title: "Find instantiations / dataclass usage",
      description:
        "Find where a class is constructed or used — the answer find_callers can't give directly, because " +
        "cs.<Class>.new() edges land on the constructor (not the Class) and ORDA cs.<Entity> / ds.<DataClass> " +
        "forms don't edge to the class at all. For any user class, returns direct cs.<Class>.new() sites. " +
        "For an ORDA class (Entity, EntitySelection, or DataClass) it additionally returns every " +
        "ds.<DataClass>.<method> CRUD site (new/query/get/all/…) that creates or returns entities, each tagged " +
        "with the form used.",
      inputSchema: { className: z.string().describe("The class name (any user class; ORDA entity/selection/dataclass for CRUD-usage sites)."), limit: z.number().int().min(1).max(500).optional() }
    },
    async ({ className, limit }) => result(findInstantiations(state.getGraph(), root(), className, limit))
  );

  server.registerTool(
    "find_overrides",
    {
      title: "Find overrides",
      description:
        "Given a class function (Function / Function get / Function set), list the members in descendant " +
        "classes that override it.",
      inputSchema: selectorShape
    },
    async (sel) => result(findOverridesQuery(state.getGraph(), root(), sel))
  );

  server.registerTool(
    "find_overridden",
    {
      title: "Find overridden function",
      description: "Given a class function, return the nearest ancestor-class function it overrides, if any.",
      inputSchema: selectorShape
    },
    async (sel) => result(findOverriddenQuery(state.getGraph(), root(), sel))
  );

  server.registerTool(
    "reindex",
    {
      title: "Rebuild the index",
      description: "Force a full re-index of the project. Normally unnecessary — the server reloads on cache changes.",
      inputSchema: {}
    },
    async () => {
      await state.reindex();
      return result({ ok: true, symbols: state.getGraph().allSymbols().length });
    }
  );
}
