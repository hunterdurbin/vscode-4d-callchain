import { CallGraph, CallKind, SymbolKind } from "@4d/core";

// Pure trace-tree data builder (no vscode import — unit-testable).
//
// A trace row is one call SITE, not one callee: a method that calls Foo three
// times produces three rows, ordered by source position, so the tree reads as
// the execution order of the method body (minus control flow).

export interface TraceRow {
  nodeId: string;
  calleeId: string;
  name: string;
  kind: SymbolKind;
  ownerClass?: string;
  callKind: CallKind;
  resolved: boolean;
  access?: "read" | "write";
  /** 0-based call-site line in the CALLER's file. */
  line: number;
  column?: number;
  endColumn?: number;
  fromId: string;
  /** Trimmed source line of the call site. */
  raw: string;
  /** Number of calls the callee itself makes (before any filtering). */
  childCount: number;
  /** Callee already appears in the ancestor chain — render "↻", don't expand. */
  recursive: boolean;
  children?: TraceRow[];
}

export interface TraceBudget {
  left: number;
}

/**
 * Build the rows for one expansion level (depth = 1) or a pre-expanded
 * subtree (depth > 1). `ancestors` must contain the chain root → … → parent,
 * including `calleeId` itself. The shared `budget` caps total rows produced;
 * when it runs out, deeper levels are simply not generated (the webview shows
 * a truncation notice from the caller).
 */
export function buildTraceChildren(
  graph: CallGraph,
  calleeId: string,
  ancestors: ReadonlySet<string>,
  depth: number,
  nextId: () => string,
  budget: TraceBudget
): TraceRow[] {
  if (depth < 1 || budget.left <= 0) return [];

  const edges = [...graph.callees(calleeId)].sort(
    (a, b) => a.line - b.line || (a.column ?? 0) - (b.column ?? 0)
  );

  const rows: TraceRow[] = [];
  for (const e of edges) {
    if (budget.left <= 0) break;
    budget.left--;

    const s = graph.symbol(e.toId);
    const recursive = ancestors.has(e.toId);
    const row: TraceRow = {
      nodeId: nextId(),
      calleeId: e.toId,
      name: s ? s.name : e.toId,
      kind: s ? s.kind : SymbolKind.Unresolved,
      ownerClass: s?.ownerClass,
      callKind: e.callKind,
      resolved: e.resolved,
      access: e.access,
      line: e.line,
      column: e.column,
      endColumn: e.endColumn,
      fromId: e.fromId,
      raw: (e.raw ?? "").trim(),
      childCount: graph.callees(e.toId).length,
      recursive
    };
    if (depth > 1 && !recursive && row.childCount > 0) {
      row.children = buildTraceChildren(
        graph,
        e.toId,
        new Set([...ancestors, e.toId]),
        depth - 1,
        nextId,
        budget
      );
    }
    rows.push(row);
  }
  return rows;
}

/** Category ids used by the kind filter (webview + settings). */
export const KIND_CATEGORIES: Record<string, SymbolKind[]> = {
  methods: [SymbolKind.ProjectMethod, SymbolKind.CompilerMethod, SymbolKind.DatabaseMethod],
  classes: [
    SymbolKind.Class,
    SymbolKind.ClassFunction,
    SymbolKind.ClassConstructor,
    SymbolKind.ClassGetter,
    SymbolKind.ClassSetter,
    SymbolKind.ClassProperty,
    SymbolKind.Alias
  ],
  forms: [
    SymbolKind.Form,
    SymbolKind.FormMethod,
    SymbolKind.FormObjectMethod,
    SymbolKind.TableForm,
    SymbolKind.TableFormMethod,
    SymbolKind.TableObjectMethod
  ],
  builtins: [SymbolKind.Builtin, SymbolKind.TableBuiltin],
  constants: [SymbolKind.Constant, SymbolKind.BuiltinConstant],
  variables: [SymbolKind.ProcessVariable, SymbolKind.InterprocessVariable],
  plugins: [SymbolKind.Plugin, SymbolKind.PluginCommand],
  components: [SymbolKind.Component, SymbolKind.ComponentMethod],
  unresolved: [SymbolKind.Unresolved]
};
