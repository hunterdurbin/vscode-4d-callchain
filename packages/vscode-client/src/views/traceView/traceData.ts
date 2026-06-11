import {
  CallGraph,
  CallKind,
  SymbolKind,
  FUNCTION_KINDS,
  resolveMemberForClass,
  overrideCandidates,
  overridesForClass
} from "@4d/core";
import type { MemberSlot, SymbolRecord } from "@4d/core";

// Pure trace-tree data builder (no vscode import — unit-testable).
//
// A trace row is one call SITE, not one callee: a method that calls Foo three
// times produces three rows, ordered by source position, so the tree reads as
// the execution order of the method body (minus control flow).
//
// Polymorphic dispatch: the builder carries a "pinned receiver class" — the
// concrete class of the instance the trace is currently inside. Edges tagged
// `receiver: "this"` re-resolve their member against the pinned class's
// inheritance chain (nearest override wins), so a base-class skeleton calling
// `This.hook()` traces into the override that actually runs. When the receiver
// can't be pinned (trace rooted at the base, entry through a base-typed edge,
// or an abstract hook with no impl), descendant overrides are attached as
// "may run" alternative rows, each expandable with its own class pinned.

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
  /** Receiver class pinned for this row's subtree (what `This.` resolves against). */
  receiverClass?: string;
  /** calleeId was re-resolved against receiverClass and differs from the static target. */
  dispatched?: boolean;
  /** When dispatched: the static target's id (the edge's original toId). */
  staticCalleeId?: string;
  /** When dispatched: human label of the static target, e.g. "Animal.hook". */
  staticLabel?: string;
  /** "may run" subclass-override rows nested under this row (each expandable). */
  alternatives?: TraceRow[];
  /** This row IS a may-run alternative (rendered ghosted with an ↪ prefix). */
  isAlternative?: boolean;
}

export interface TraceBudget {
  left: number;
}

/** Memoizes overridesForClass per class across one expansion/rebuild. */
export interface TraceCaches {
  overrides: Map<string, Map<string, SymbolRecord[]>>;
}

export function createTraceCaches(): TraceCaches {
  return { overrides: new Map() };
}

function cachedOverrides(graph: CallGraph, caches: TraceCaches, className: string): Map<string, SymbolRecord[]> {
  const key = className.toLowerCase();
  let map = caches.overrides.get(key);
  if (!map) {
    map = overridesForClass(graph, className);
    caches.overrides.set(key, map);
  }
  return map;
}

/** Kinds whose calls can dispatch to subclass overrides. */
const DISPATCHABLE_KINDS: ReadonlySet<SymbolKind> = new Set([
  ...FUNCTION_KINDS,
  SymbolKind.ClassProperty,
  SymbolKind.Alias,
  SymbolKind.Unresolved
]);

/** Member name behind an edge: a class member's own name, or the `x` of `Unresolved:This.x`. */
function memberNameOf(staticSym: SymbolRecord | undefined): string | undefined {
  if (!staticSym) return undefined;
  if (staticSym.ownerClass) return staticSym.name;
  if (staticSym.kind === SymbolKind.Unresolved) {
    return /^This\.([^.()\s]+)$/.exec(staticSym.name)?.[1];
  }
  return undefined;
}

function labelOf(s: SymbolRecord): string {
  return s.ownerClass ? `${s.ownerClass}.${s.name}` : s.name;
}

/**
 * Build the rows for one expansion level (depth = 1) or a pre-expanded
 * subtree (depth > 1). `ancestors` must contain the chain root → … → parent,
 * including `calleeId` itself. The shared `budget` caps total rows produced;
 * when it runs out, deeper levels are simply not generated (the webview shows
 * a truncation notice from the caller). `receiverClass` is the concrete class
 * pinned for this subtree; `caches` may be shared across calls to amortize
 * override scans.
 */
export function buildTraceChildren(
  graph: CallGraph,
  calleeId: string,
  ancestors: ReadonlySet<string>,
  depth: number,
  nextId: () => string,
  budget: TraceBudget,
  receiverClass?: string,
  caches: TraceCaches = createTraceCaches()
): TraceRow[] {
  if (depth < 1 || budget.left <= 0) return [];

  const edges = [...graph.callees(calleeId)].sort(
    (a, b) => a.line - b.line || (a.column ?? 0) - (b.column ?? 0)
  );

  const rows: TraceRow[] = [];
  for (const e of edges) {
    if (budget.left <= 0) break;
    budget.left--;

    const slot: MemberSlot = e.access === "read" ? "read" : e.access === "write" ? "write" : "call";
    const staticSym = graph.symbol(e.toId);
    const memberName = memberNameOf(staticSym);

    // ── Dispatch: re-resolve This.* against the pinned receiver class ──
    let effectiveId = e.toId;
    let dispatched = false;
    if (e.receiver === "this" && receiverClass && memberName) {
      const hit = resolveMemberForClass(graph, receiverClass, memberName, slot);
      if (hit && hit.id !== e.toId) {
        effectiveId = hit.id;
        dispatched = true;
      }
    }
    // receiver === "super" never re-resolves: the parent impl runs by design.

    const effSym = effectiveId === e.toId ? staticSym : graph.symbol(effectiveId);
    const recursive = ancestors.has(effectiveId);

    // ── Receiver context for this row's subtree ──
    // This/Super calls stay on the same instance; untagged edges into a class
    // member enter that object's context (its static type); anything else
    // (project methods, builtins…) clears the pin.
    const childReceiver =
      e.receiver === "this" || e.receiver === "super"
        ? receiverClass ?? effSym?.ownerClass
        : effSym?.ownerClass;

    const row: TraceRow = {
      nodeId: nextId(),
      calleeId: effectiveId,
      name: effSym ? effSym.name : effectiveId,
      kind: effSym ? effSym.kind : SymbolKind.Unresolved,
      ownerClass: effSym?.ownerClass,
      callKind: e.callKind,
      resolved: dispatched ? true : e.resolved,
      access: e.access,
      line: e.line,
      column: e.column,
      endColumn: e.endColumn,
      fromId: e.fromId,
      raw: (e.raw ?? "").trim(),
      childCount: graph.callees(effectiveId).length,
      recursive,
      receiverClass: childReceiver
    };
    if (dispatched && staticSym) {
      row.dispatched = true;
      row.staticCalleeId = staticSym.id;
      row.staticLabel = labelOf(staticSym);
    }

    // ── "May run" alternatives when the receiver isn't proven exact ──
    // A pin is a static type bound, not a proof of exact type, so even a
    // resolved row can dispatch lower — but a successful re-resolution
    // (dispatched) already answered the question for the pinned class.
    const effKind = effSym ? effSym.kind : SymbolKind.Unresolved;
    if (
      childReceiver &&
      memberName &&
      !recursive &&
      !dispatched &&
      e.receiver !== "super" &&
      DISPATCHABLE_KINDS.has(effKind)
    ) {
      const alts = overrideCandidates(
        graph,
        childReceiver,
        memberName,
        slot,
        cachedOverrides(graph, caches, childReceiver)
      ).filter((a) => a.id !== effectiveId);
      const altRows: TraceRow[] = [];
      for (const a of alts) {
        if (budget.left <= 0) break;
        budget.left--;
        altRows.push({
          nodeId: nextId(),
          calleeId: a.id,
          name: a.name,
          kind: a.kind,
          ownerClass: a.ownerClass,
          callKind: e.callKind,
          resolved: true,
          access: e.access,
          line: e.line,
          column: e.column,
          endColumn: e.endColumn,
          fromId: e.fromId,
          raw: (e.raw ?? "").trim(),
          childCount: graph.callees(a.id).length,
          recursive: ancestors.has(a.id),
          receiverClass: a.ownerClass,
          isAlternative: true
        });
      }
      if (altRows.length > 0) row.alternatives = altRows;
    }

    if (depth > 1 && !recursive && row.childCount > 0) {
      row.children = buildTraceChildren(
        graph,
        effectiveId,
        new Set([...ancestors, effectiveId]),
        depth - 1,
        nextId,
        budget,
        childReceiver,
        caches
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
