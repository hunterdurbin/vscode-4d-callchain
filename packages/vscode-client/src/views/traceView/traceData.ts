import {
  CallGraph,
  CallKind,
  SymbolKind,
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
// concrete class of the instance the trace is currently inside, treated as
// the EXACT runtime type. Edges tagged `receiver: "this"` re-resolve their
// member against the pinned class's inheritance chain (nearest override
// wins), so a base-class skeleton calling `This.hook()` traces into the
// override that actually runs. Only when no implementation can be determined
// at all (an abstract hook with no impl anywhere on the pinned chain) are
// descendant overrides attached as "may run" alternative rows, each
// expandable with its own class pinned.

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
  /**
   * Number of subclass overrides of this member that exist BELOW the
   * effective target's class — informational ("⇣ N" badge): they are not the
   * determined target for this trace's receiver, but other call paths can
   * reach them.
   */
  overrideCount?: number;
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
    // This/Super calls stay on the same instance. Other edges enter that
    // object's context: prefer the statically-known receiver class recorded
    // at index time (`$dog.run()` → "Dog" even when run is declared on
    // Animal; `cs.Dog.new()` → "Dog" even with an inherited constructor),
    // falling back to the resolved member's declaring class. Non-class
    // targets (project methods, builtins…) clear the pin.
    const childReceiver =
      e.receiver === "this" || e.receiver === "super"
        ? receiverClass ?? effSym?.ownerClass
        : e.receiverClass ?? effSym?.ownerClass;

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

    // ── "⇣ N" informational badge: overrides below the effective target ──
    // Not the determined target for THIS receiver, but other call paths can
    // reach them. Only for class-member targets.
    if (effSym?.ownerClass && memberName) {
      const count = overrideCandidates(
        graph,
        effSym.ownerClass,
        memberName,
        slot,
        cachedOverrides(graph, caches, effSym.ownerClass)
      ).filter((a) => a.id !== effectiveId).length;
      if (count > 0) row.overrideCount = count;
    }

    // ── "May run" alternatives only when nothing could be determined ──
    // A pinned receiver is treated as the EXACT runtime type: when chain
    // resolution finds an implementation (the static target or an override),
    // that is the function that runs — no alternatives. May-run rows appear
    // only for an unresolved member reference (an abstract hook with no
    // implementation anywhere on the pinned chain), listing the pinned
    // class's descendant implementations.
    const effKind = effSym ? effSym.kind : SymbolKind.Unresolved;
    if (
      childReceiver &&
      memberName &&
      !recursive &&
      e.receiver !== "super" &&
      effKind === SymbolKind.Unresolved
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

/**
 * On-demand override rows for the context menu's "Show overrides": the same
 * candidate set the "⇣ N" badge counts, shaped exactly like the automatic
 * "may run" alternatives (ghosted ↪ rows, each expandable with its own class
 * pinned). `ancestors` is the PARENT chain (not including `base.calleeId`),
 * mirroring how in-tree alternatives register.
 */
export function buildOverrideRows(
  graph: CallGraph,
  base: TraceRow,
  ancestors: ReadonlySet<string>,
  nextId: () => string
): TraceRow[] {
  const sym = graph.symbol(base.calleeId);
  if (!sym?.ownerClass) return [];
  const slot: MemberSlot = base.access === "read" ? "read" : base.access === "write" ? "write" : "call";
  return overrideCandidates(graph, sym.ownerClass, sym.name, slot)
    .filter((a) => a.id !== base.calleeId)
    .map((a) => ({
      nodeId: nextId(),
      calleeId: a.id,
      name: a.name,
      kind: a.kind,
      ownerClass: a.ownerClass,
      callKind: base.callKind,
      resolved: true,
      access: base.access,
      line: base.line,
      column: base.column,
      endColumn: base.endColumn,
      fromId: base.fromId,
      raw: base.raw,
      childCount: graph.callees(a.id).length,
      recursive: ancestors.has(a.id),
      receiverClass: a.ownerClass,
      isAlternative: true
    }));
}

/**
 * One filterable category in the trace's Kinds menu. `access` narrows a
 * category to read or write references — the property categories share the
 * ClassProperty/Alias kinds and are distinguished only by the edge's access.
 */
export interface TraceCategory {
  kinds: SymbolKind[];
  access?: "read" | "write";
}

/** Category descriptors used by the kind filter (webview + settings). */
export const TRACE_CATEGORIES: Record<string, TraceCategory> = {
  methods: { kinds: [SymbolKind.ProjectMethod, SymbolKind.CompilerMethod, SymbolKind.DatabaseMethod] },
  classConstructors: { kinds: [SymbolKind.ClassConstructor, SymbolKind.Class] },
  classFunctions: { kinds: [SymbolKind.ClassFunction] },
  classGetters: { kinds: [SymbolKind.ClassGetter] },
  classSetters: { kinds: [SymbolKind.ClassSetter] },
  propertyReads: { kinds: [SymbolKind.ClassProperty, SymbolKind.Alias], access: "read" },
  propertyWrites: { kinds: [SymbolKind.ClassProperty, SymbolKind.Alias], access: "write" },
  forms: {
    kinds: [
      SymbolKind.Form,
      SymbolKind.FormMethod,
      SymbolKind.FormObjectMethod,
      SymbolKind.TableForm,
      SymbolKind.TableFormMethod,
      SymbolKind.TableObjectMethod
    ]
  },
  builtins: { kinds: [SymbolKind.Builtin, SymbolKind.TableBuiltin] },
  constants: { kinds: [SymbolKind.Constant, SymbolKind.BuiltinConstant] },
  variables: { kinds: [SymbolKind.ProcessVariable, SymbolKind.InterprocessVariable] },
  plugins: { kinds: [SymbolKind.Plugin, SymbolKind.PluginCommand] },
  components: { kinds: [SymbolKind.Component, SymbolKind.ComponentMethod] },
  unresolved: { kinds: [SymbolKind.Unresolved] }
};

/** Setting value migration: the old "classes" umbrella → the six fine-grained ids. */
export const LEGACY_CLASSES_CATEGORIES = [
  "classConstructors",
  "classFunctions",
  "classGetters",
  "classSetters",
  "propertyReads",
  "propertyWrites"
];

/** View settings the "Save as default" button snapshots into workspaceState. */
export interface TraceOptions {
  hiddenKinds: string[]; // TRACE_CATEGORIES keys
  showSnippets: boolean;
  expandDepth: number; // 1..6 — preset for the "Expand to" selector
}

/** Deserialization guard for workspaceState round-trips: unknown category ids
 *  are dropped, the depth is clamped, and missing/invalid input falls back to
 *  the config-derived seed (with depth 1). */
export function normalizeTraceOptions(
  raw: unknown,
  seed: { hiddenKinds: string[]; showSnippets: boolean }
): TraceOptions {
  const d: TraceOptions = { hiddenKinds: seed.hiddenKinds, showSnippets: seed.showSnippets, expandDepth: 1 };
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  const depth = Number(r.expandDepth);
  return {
    hiddenKinds: Array.isArray(r.hiddenKinds)
      ? r.hiddenKinds.filter((k): k is string => typeof k === "string" && k in TRACE_CATEGORIES)
      : d.hiddenKinds,
    showSnippets: typeof r.showSnippets === "boolean" ? r.showSnippets : d.showSnippets,
    expandDepth: Number.isFinite(depth) ? Math.min(6, Math.max(1, Math.round(depth))) : d.expandDepth
  };
}
