import { CallGraph, CallKind, SymbolKind } from "@4d/core";
import type { CallEdge, SymbolRecord } from "@4d/core";

// Pure butterfly-graph data builder (no vscode import — unit-testable).
//
// Layout model: the center symbol sits at tier 0; its callers fan out to the
// left across tiers 1..callerDepth, callees to the right across tiers
// 1..calleeDepth. A symbol that is both a caller and a callee of the center
// appears once per side — element ids are side-prefixed ("L:…" / "R:…") so
// the two placements never collide and cycles can't pull a node across the
// midline. The center itself is never materialized inside a wing; direct
// recursion becomes a C→C self-loop.
//
// Each wing runs through a fixed stage order (the determinism contract for
// how the hide/compress options interact):
//   1. expand        — per-side depth + layout mode; unreachable calls are
//                      pruned here when unreachable="hide", else flagged;
//                      class-chip inventory is collected here (pre-hide)
//   2. class stubs   — nodes whose chip key is hidden become stubs
//   3. prune         — stubs with no outward edges vanish (hidden leaves)
//   4. pass-through  — 1-in/1-out nodes become stubs when compression is on;
//                      degrees count DISTINCT neighbors (a parallel multi-
//                      call-site bundle is ONE pair, self-loops excluded), so
//                      the dupEdges option never changes what compresses
//   5. merge         — adjacent stubs collapse into one (union-find)
//   6. prune again   — merging can expose dead stub tails
//   7. order + place — sort rows, assign positions (column stack / tidy tree)
//   8. emit          — split edges per dupEdges mode, build labels

export type UnreachableMode = "gray" | "hide";
export type DupEdgeMode = "collapse" | "expand";
export type SortMode = "alpha" | "minCross" | "callSite";
export type LabelMode = "name" | "type"; // extensible: "body" later
export type WingMode = "graph" | "tree" | "treeLeft";

export interface ButterflyOptions {
  unreachable: UnreachableMode;
  hiddenClasses: string[];
  compressPassThrough: boolean;
  dupEdges: DupEdgeMode;
  sort: SortMode;
  label: LabelMode;
  callerDepth: number; // 1..6
  calleeDepth: number; // 1..6
  callerMode: WingMode;
  calleeMode: WingMode;
  optionsBarCollapsed: boolean; // UI-only, persisted with the rest
}

const UNREACHABLE_MODES: readonly UnreachableMode[] = ["gray", "hide"];
const DUP_EDGE_MODES: readonly DupEdgeMode[] = ["collapse", "expand"];
const SORT_MODES: readonly SortMode[] = ["alpha", "minCross", "callSite"];
const LABEL_MODES: readonly LabelMode[] = ["name", "type"];
const WING_MODES: readonly WingMode[] = ["graph", "tree", "treeLeft"];
const MIN_DEPTH = 1;
const MAX_DEPTH = 6;

export function defaultButterflyOptions(seedDepth: number): ButterflyOptions {
  const depth = clampDepth(seedDepth, 1);
  return {
    unreachable: "gray",
    hiddenClasses: [],
    compressPassThrough: false,
    dupEdges: "collapse",
    sort: "alpha",
    label: "name",
    callerDepth: depth,
    calleeDepth: depth,
    callerMode: "graph",
    calleeMode: "graph",
    optionsBarCollapsed: false
  };
}

/** Deserialization guard for workspaceState round-trips: clamps, validates
 *  enums against allowlists and fills missing keys from defaults, so stored
 *  blobs from older/newer versions always load. */
export function normalizeButterflyOptions(raw: unknown, seedDepth: number): ButterflyOptions {
  const d = defaultButterflyOptions(seedDepth);
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  return {
    unreachable: pickEnum(r.unreachable, UNREACHABLE_MODES, d.unreachable),
    hiddenClasses: Array.isArray(r.hiddenClasses)
      ? r.hiddenClasses.filter((s): s is string => typeof s === "string")
      : d.hiddenClasses,
    compressPassThrough: typeof r.compressPassThrough === "boolean" ? r.compressPassThrough : d.compressPassThrough,
    dupEdges: pickEnum(r.dupEdges, DUP_EDGE_MODES, d.dupEdges),
    sort: pickEnum(r.sort, SORT_MODES, d.sort),
    label: pickEnum(r.label, LABEL_MODES, d.label),
    callerDepth: clampDepth(r.callerDepth, d.callerDepth),
    calleeDepth: clampDepth(r.calleeDepth, d.calleeDepth),
    callerMode: pickEnum(r.callerMode, WING_MODES, d.callerMode),
    calleeMode: pickEnum(r.calleeMode, WING_MODES, d.calleeMode),
    optionsBarCollapsed: typeof r.optionsBarCollapsed === "boolean" ? r.optionsBarCollapsed : d.optionsBarCollapsed
  };
}

function pickEnum<T extends string>(v: unknown, allowed: readonly T[], dflt: T): T {
  return allowed.includes(v as T) ? (v as T) : dflt;
}

function clampDepth(v: unknown, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(MAX_DEPTH, Math.max(MIN_DEPTH, Math.round(n))) : dflt;
}

/** The "Call site line number" sort affects nothing when both wings are
 *  merged graphs with collapsed duplicate edges — the UI disables it then. */
export function callSiteSortApplicable(o: ButterflyOptions): boolean {
  return o.callerMode !== "graph" || o.calleeMode !== "graph" || o.dupEdges === "expand";
}

/** Group key for the "hide methods from these classes/namespaces" chips.
 *  Parenthesized keys can't collide with 4D class names. */
export function chipKeyOf(sym: SymbolRecord | undefined): string {
  if (sym?.ownerClass) return sym.ownerClass;
  switch (sym?.kind) {
    case SymbolKind.Builtin:
    case SymbolKind.TableBuiltin:
    case SymbolKind.BuiltinConstant:
      return "(builtins)";
    case SymbolKind.Constant:
      return "(constants)";
    default:
      return "(top-level)";
  }
}

/** Compact one-line signature for the "Type" label mode.
 *  `name(p1 : T1; p2 : T2) : Ret` — 4D separates params with `;`. */
export function formatSignature(sym: SymbolRecord): string {
  const ret = sym.returnType ? ` : ${sym.returnType}` : "";
  const params = (sym.params ?? [])
    .map((p) => {
      const base = p.type ? `${p.name} : ${p.type}` : p.name;
      return p.variadic ? `${base}…` : base;
    })
    .join("; ");
  if (sym.accessor === "get") return `get ${sym.name}${ret}`;
  if (sym.accessor === "set") return `set ${sym.name}(${params})`;
  if (sym.kind === SymbolKind.ClassConstructor) return `new ${sym.ownerClass ?? sym.name}(${params})`;
  if (!sym.params && !sym.returnType) return sym.name;
  return `${sym.name}(${params})${ret}`;
}

export interface ButterflyNode {
  elId: string; // "C" | graph: "L:<id>"/"R:<id>" | tree: path-joined | merged stub: "L*<n>"/"R*<n>"
  symbolId: string; // "" on stubs — taps are no-ops there
  label: string; // "" on stubs; signature when label mode = "type"
  kind: SymbolKind;
  ownerClass?: string;
  side: "center" | "caller" | "callee";
  tier: number; // 0 = center, 1.. outward
  row: number; // vertical position in row units; webview does y = row * ROW_GAP
  stub?: boolean; // tiny blank pass-through rect
  unreachable?: boolean; // dimmed (only emitted when unreachable === "gray")
  recursive?: boolean; // tree-mode cycle cut
  hiddenLabels?: string[]; // stubs: labels of the symbols folded in
}

export interface ButterflyEdge {
  id: string;
  source: string; // elId — always the CALLER end, so the line badge sits on the node containing the call site
  target: string; // elId
  kind: CallKind;
  resolved: boolean;
  unreachable?: boolean;
  line?: number; // dupEdges="expand": 1-based call-site line, rendered as a source-label badge
}

export interface ClassChip {
  key: string;
  label: string;
  count: number; // distinct symbols in the current butterfly (pre-hide)
  hidden: boolean;
  present: boolean; // false: persisted-hidden but absent around this center
}

export interface ButterflyData {
  centerId: string;
  centerLabel: string;
  nodes: ButterflyNode[];
  edges: ButterflyEdge[];
  classChips: ClassChip[];
  visitedIds: string[];
  canGoBack: boolean;
  canGoForward: boolean;
  truncated: boolean;
}

// ── Internal wing representation ────────────────────────────────────────────

interface SiteRef {
  e: CallEdge;
  unreachable: boolean;
}

interface WNode {
  key: string; // becomes elId
  symbolId: string;
  sym?: SymbolRecord;
  label: string;
  tier: number;
  stub: boolean;
  unreachable: boolean;
  recursive: boolean;
  members: string[]; // labels folded into a merged stub
  parentKey?: string; // tree modes: layout parent ("C" for tier-1 in tree mode)
  row: number;
}

interface WEdge {
  from: string; // caller-end key (call direction), or "C"
  to: string; // callee-end key, or "C"
  sites: SiteRef[];
}

interface Wing {
  side: "caller" | "callee";
  mode: WingMode;
  nodes: Map<string, WNode>;
  edges: Map<string, WEdge>; // keyed `${from}\u0000${to}`
  truncated: boolean;
}

const PATH_SEP = "\u001f"; // can't occur in symbol ids built from 4D names

function edgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

function addSites(wing: Wing, from: string, to: string, sites: SiteRef[]): void {
  const key = edgeKey(from, to);
  const existing = wing.edges.get(key);
  if (existing) existing.sites.push(...sites);
  else wing.edges.set(key, { from, to, sites: [...sites] });
}

/** Edges on a node's center side ("inward") vs. periphery side ("outward").
 *  Caller wing: outer nodes CALL inner ones, so n's outward edges are those
 *  where n is the callee (`to === n`); mirrored on the callee wing. */
function isOutwardEdge(side: "caller" | "callee", e: WEdge, key: string): boolean {
  if (e.from === e.to) return false;
  return side === "caller" ? e.to === key : e.from === key;
}

function isInwardEdge(side: "caller" | "callee", e: WEdge, key: string): boolean {
  if (e.from === e.to) return false;
  return side === "caller" ? e.from === key : e.to === key;
}

// ── Main entry ──────────────────────────────────────────────────────────────

export function buildButterfly(
  graph: CallGraph,
  centerId: string,
  options: ButterflyOptions,
  visited: ReadonlySet<string>,
  history: { back: boolean; fwd: boolean },
  nodeCap = 400
): ButterflyData {
  const center = graph.symbol(centerId);
  const base: ButterflyData = {
    centerId,
    centerLabel: center ? (center.ownerClass ? `${center.ownerClass}.${center.name}` : center.name) : centerId,
    nodes: [],
    edges: [],
    classChips: [],
    visitedIds: [...visited].filter((id) => id !== centerId),
    canGoBack: history.back,
    canGoForward: history.fwd,
    truncated: false
  };
  if (!center) return base;

  const sideCap = Math.max(1, Math.floor(nodeCap / 2));
  const hidden = new Set(options.hiddenClasses);
  const chipSymbols = new Map<string, Set<string>>(); // chip key → distinct symbol ids (pre-hide)

  const wings: Wing[] = [
    expandWing(graph, centerId, "caller", options.callerMode, options.callerDepth, options.unreachable, sideCap, chipSymbols),
    expandWing(graph, centerId, "callee", options.calleeMode, options.calleeDepth, options.unreachable, sideCap, chipSymbols)
  ];

  for (const wing of wings) {
    markClassStubs(wing, hidden);
    pruneDanglingStubs(wing);
    if (options.compressPassThrough) markPassThroughStubs(wing);
    mergeAdjacentStubs(wing);
    pruneDanglingStubs(wing);
    orderAndPlace(wing, options);
  }

  // Chips: everything seen around this center, plus persisted-hidden keys
  // that aren't present right now (so a chip can always be re-enabled).
  const chipKeys = new Set([...chipSymbols.keys(), ...hidden]);
  const classChips: ClassChip[] = [...chipKeys]
    .sort((a, b) => a.localeCompare(b))
    .map((key) => ({
      key,
      label: key,
      count: chipSymbols.get(key)?.size ?? 0,
      hidden: hidden.has(key),
      present: chipSymbols.has(key)
    }));

  return {
    ...base,
    ...emit(center, centerId, wings, options),
    classChips,
    truncated: wings.some((w) => w.truncated)
  };
}

// ── Stage 1: expansion ──────────────────────────────────────────────────────

function isUnreachableEdge(e: CallEdge, otherSym: SymbolRecord | undefined): boolean {
  return (
    !e.resolved ||
    e.callKind === CallKind.Dynamic ||
    e.callKind === CallKind.Formula ||
    !otherSym ||
    otherSym.kind === SymbolKind.Unresolved
  );
}

function makeWNode(key: string, symbolId: string, sym: SymbolRecord | undefined, tier: number): WNode {
  return {
    key,
    symbolId,
    sym,
    label: sym ? sym.name : symbolId,
    tier,
    stub: false,
    unreachable: !sym || sym.kind === SymbolKind.Unresolved,
    recursive: false,
    members: [],
    row: 0
  };
}

function expandWing(
  graph: CallGraph,
  centerId: string,
  side: "caller" | "callee",
  mode: WingMode,
  depth: number,
  unreachableMode: UnreachableMode,
  sideCap: number,
  chipSymbols: Map<string, Set<string>>
): Wing {
  const wing: Wing = { side, mode, nodes: new Map(), edges: new Map(), truncated: false };
  const prefix = side === "caller" ? "L:" : "R:";

  const recordChip = (symbolId: string, sym: SymbolRecord | undefined) => {
    const key = chipKeyOf(sym);
    let set = chipSymbols.get(key);
    if (!set) chipSymbols.set(key, (set = new Set()));
    set.add(symbolId);
  };

  /** Neighbor call-site bundles for one symbol, sorted for determinism.
   *  Unreachable sites are dropped here when hiding; bundles left empty
   *  vanish (and the subtree behind them is never expanded). */
  const neighborBundles = (symbolId: string): { other: string; sym?: SymbolRecord; sites: SiteRef[] }[] => {
    const raw = side === "caller" ? graph.callers(symbolId) : graph.callees(symbolId);
    const byOther = new Map<string, SiteRef[]>();
    for (const e of raw) {
      const other = side === "caller" ? e.fromId : e.toId;
      const otherSym = graph.symbol(other);
      const unreachable = isUnreachableEdge(e, otherSym);
      if (unreachable && unreachableMode === "hide") continue;
      const list = byOther.get(other);
      if (list) list.push({ e, unreachable });
      else byOther.set(other, [{ e, unreachable }]);
    }
    return [...byOther.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([other, sites]) => ({ other, sym: graph.symbol(other), sites }));
  };

  if (mode === "graph") {
    let frontier: string[] = [centerId];
    for (let tier = 1; tier <= depth && frontier.length > 0; tier++) {
      const next: string[] = [];
      for (const symbolId of frontier) {
        const symKey = symbolId === centerId ? "C" : prefix + symbolId;
        for (const { other, sym, sites } of neighborBundles(symbolId)) {
          if (other === centerId) {
            // Direct recursion shows as a self-loop on the center (added by
            // the callee wing only, so it isn't doubled); deeper cycles back
            // into the center are dropped — the counterpart node already
            // appears on the opposite wing.
            if (symbolId === centerId && side === "callee") addSites(wing, "C", "C", sites);
            continue;
          }
          let node = wing.nodes.get(prefix + other);
          if (!node) {
            if (wing.nodes.size >= sideCap) {
              wing.truncated = true;
              continue;
            }
            node = makeWNode(prefix + other, other, sym, tier);
            wing.nodes.set(node.key, node);
            recordChip(other, sym);
            next.push(other);
          }
          if (side === "caller") addSites(wing, node.key, symKey, sites);
          else addSites(wing, symKey, node.key, sites);
        }
      }
      frontier = next;
    }
    return wing;
  }

  // Tree modes enumerate call paths center-outward with cycle cutting.
  if (mode === "tree") {
    const visit = (symbolId: string, parentKey: string, ancestors: Set<string>, tier: number) => {
      if (tier > depth) return;
      const parent = wing.nodes.get(parentKey);
      for (const { other, sym, sites } of neighborBundles(symbolId)) {
        if (other === centerId) {
          if (symbolId === centerId && side === "callee") addSites(wing, "C", "C", sites);
          else if (parent) parent.recursive = true;
          continue;
        }
        if (ancestors.has(other)) {
          if (parent) parent.recursive = true;
          continue;
        }
        if (wing.nodes.size >= sideCap) {
          wing.truncated = true;
          return;
        }
        const key = parentKey === "C" ? prefix + other : parentKey + PATH_SEP + other;
        const node = makeWNode(key, other, sym, tier);
        node.parentKey = parentKey;
        wing.nodes.set(key, node);
        recordChip(other, sym);
        if (side === "caller") addSites(wing, key, parentKey, sites);
        else addSites(wing, parentKey, key, sites);
        ancestors.add(other);
        visit(other, key, ancestors, tier + 1);
        ancestors.delete(other);
      }
    };
    visit(centerId, "C", new Set([centerId]), 1);
    return wing;
  }

  // treeLeft: a reversed-path trie. Enumerate the same paths tree mode would,
  // then insert each REVERSED path into a trie — outermost callers (entry
  // points like `main`) appear once and duplication migrates toward the
  // center. A trie node that ends ≥1 path is "terminal" and carries that
  // path's center-adjacent call sites as an edge to/from C. Tiers are
  // assigned so all trie roots align in the outermost column.
  interface PathStep {
    symbolId: string;
    sym?: SymbolRecord;
    sites: SiteRef[]; // call sites linking this step to the previous one (or to the center for step 0)
  }
  const paths: { steps: PathStep[]; cycleCut: boolean }[] = [];
  let pathBudget = sideCap * 8;

  const walk = (symbolId: string, steps: PathStep[], ancestors: Set<string>) => {
    if (pathBudget <= 0) {
      wing.truncated = true;
      if (steps.length > 0) paths.push({ steps: [...steps], cycleCut: false });
      return;
    }
    const bundles = steps.length >= depth ? [] : neighborBundles(symbolId);
    let extended = false;
    let cycleCut = false;
    for (const { other, sym, sites } of bundles) {
      if (other === centerId) {
        if (symbolId === centerId && side === "callee") addSites(wing, "C", "C", sites);
        else cycleCut = true;
        continue;
      }
      if (ancestors.has(other)) {
        cycleCut = true;
        continue;
      }
      extended = true;
      pathBudget--;
      steps.push({ symbolId: other, sym, sites });
      ancestors.add(other);
      walk(other, steps, ancestors);
      ancestors.delete(other);
      steps.pop();
    }
    if (!extended && steps.length > 0) paths.push({ steps: [...steps], cycleCut });
  };
  walk(centerId, [], new Set([centerId]));

  for (const { steps, cycleCut } of paths) {
    // Reversed insertion: trie root = outermost step. steps[j].sites link
    // step j to step j-1 (or to the center for j = 0), so the edge between a
    // trie node and its (outer) trie parent carries the OUTER step's sites.
    let parentKey: string | undefined;
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i];
      const key = parentKey === undefined ? prefix + step.symbolId : parentKey + PATH_SEP + step.symbolId;
      let node = wing.nodes.get(key);
      if (!node) {
        if (wing.nodes.size >= sideCap) {
          wing.truncated = true;
          break;
        }
        node = makeWNode(key, step.symbolId, step.sym, 1); // tier assigned below from trie depth
        node.parentKey = parentKey;
        wing.nodes.set(key, node);
        recordChip(step.symbolId, step.sym);
      }
      if (i === steps.length - 1 && cycleCut) node.recursive = true;
      if (parentKey !== undefined) {
        const outerSites = steps[i + 1].sites;
        const from = side === "caller" ? parentKey : key; // call runs outer→inner on the caller wing
        const to = side === "caller" ? key : parentKey;
        addSites(wing, from, to, dedupeSites(wing.edges.get(edgeKey(from, to))?.sites, outerSites));
      }
      if (i === 0) {
        // Terminal: adjacent to the center; can also be an internal trie node.
        const from = side === "caller" ? key : "C";
        const to = side === "caller" ? "C" : key;
        addSites(wing, from, to, dedupeSites(wing.edges.get(edgeKey(from, to))?.sites, step.sites));
      }
      parentKey = key;
    }
  }

  // Tier from trie depth: roots (depth 1) sit outermost, aligned.
  const trieDepthOf = (n: WNode): number => {
    let d = 1;
    let p = n.parentKey;
    while (p !== undefined) {
      d++;
      p = wing.nodes.get(p)?.parentKey;
    }
    return d;
  };
  let maxTrie = 0;
  const depths = new Map<string, number>();
  for (const n of wing.nodes.values()) {
    const d = trieDepthOf(n);
    depths.set(n.key, d);
    maxTrie = Math.max(maxTrie, d);
  }
  for (const n of wing.nodes.values()) n.tier = maxTrie + 1 - (depths.get(n.key) as number);

  return wing;
}

/** Append only sites not already present (same CallEdge object or same
 *  line/column/from/to) — treeLeft revisits shared trie prefixes per path. */
function dedupeSites(existing: SiteRef[] | undefined, incoming: SiteRef[]): SiteRef[] {
  if (!existing || existing.length === 0) return incoming;
  const seen = new Set(existing.map((s) => siteIdent(s)));
  return incoming.filter((s) => !seen.has(siteIdent(s)));
}

function siteIdent(s: SiteRef): string {
  return `${s.e.fromId}|${s.e.toId}|${s.e.line}|${s.e.column ?? -1}|${s.e.callKind}|${s.e.access ?? ""}`;
}

// ── Stages 2–6: stubs ───────────────────────────────────────────────────────

function markClassStubs(wing: Wing, hidden: Set<string>): void {
  if (hidden.size === 0) return;
  for (const n of wing.nodes.values()) {
    if (hidden.has(chipKeyOf(n.sym))) n.stub = true;
  }
}

/** Stubs with no outward edges are pure dead ends — hidden leaves and hidden
 *  sub-chains vanish entirely; only true pass-throughs stay as stubs. */
function pruneDanglingStubs(wing: Wing): void {
  for (;;) {
    const dead: string[] = [];
    for (const n of wing.nodes.values()) {
      if (!n.stub) continue;
      let hasOutward = false;
      for (const e of wing.edges.values()) {
        if (isOutwardEdge(wing.side, e, n.key)) {
          hasOutward = true;
          break;
        }
      }
      if (!hasOutward) dead.push(n.key);
    }
    if (dead.length === 0) break;
    for (const key of dead) {
      wing.nodes.delete(key);
      for (const [k, e] of wing.edges) {
        if (e.from === key || e.to === key) wing.edges.delete(k);
      }
    }
  }
  // Pruning an outermost treeLeft stub orphans its layout children — they
  // become trie roots (their tier already reflects their column).
  for (const n of wing.nodes.values()) {
    if (n.parentKey !== undefined && n.parentKey !== "C" && !wing.nodes.has(n.parentKey)) {
      n.parentKey = undefined;
    }
  }
}

/** A non-center node with exactly one distinct inward neighbor and one
 *  distinct outward neighbor is a trivial forwarding hop. Degrees are
 *  counted per NEIGHBOR (parallel call sites = one pair, self-loops
 *  excluded), so dupEdges mode never changes what compresses. Recursive-
 *  marked nodes keep their box — the ↻ marker would otherwise vanish. */
function markPassThroughStubs(wing: Wing): void {
  for (const n of wing.nodes.values()) {
    if (n.stub || n.recursive) continue;
    const inward = new Set<string>();
    const outward = new Set<string>();
    for (const e of wing.edges.values()) {
      if (isInwardEdge(wing.side, e, n.key)) inward.add(wing.side === "caller" ? e.to : e.from);
      if (isOutwardEdge(wing.side, e, n.key)) outward.add(wing.side === "caller" ? e.from : e.to);
    }
    if (inward.size === 1 && outward.size === 1) n.stub = true;
  }
}

/** Union-find over stub–stub edges: each connected stub component renders as
 *  ONE tiny rect. Boundary edges rewire to the merged key; intra-component
 *  edges drop; parallel pairs created by the rewire concatenate their sites. */
function mergeAdjacentStubs(wing: Wing): void {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r) as string;
    parent.set(k, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const n of wing.nodes.values()) if (n.stub) parent.set(n.key, n.key);
  let any = false;
  for (const e of wing.edges.values()) {
    if (e.from === e.to) continue;
    const a = wing.nodes.get(e.from);
    const b = wing.nodes.get(e.to);
    if (a?.stub && b?.stub) {
      union(a.key, b.key);
      any = true;
    }
  }
  if (!any) {
    // Single stubs still lose their identity (blank box, no taps).
    for (const n of wing.nodes.values()) {
      if (n.stub) n.members = [n.label];
    }
    return;
  }

  const components = new Map<string, string[]>();
  for (const n of wing.nodes.values()) {
    if (!n.stub) continue;
    const root = find(n.key);
    const list = components.get(root);
    if (list) list.push(n.key);
    else components.set(root, [n.key]);
  }

  const prefix = wing.side === "caller" ? "L*" : "R*";
  const keyMap = new Map<string, string>();
  const multi = [...components.values()].filter((m) => m.length > 1);
  multi.sort((a, b) => min(a).localeCompare(min(b))); // deterministic numbering
  multi.forEach((members, i) => {
    const mergedKey = `${prefix}${i}`;
    const nodes = members.map((k) => wing.nodes.get(k) as WNode).sort((a, b) => a.tier - b.tier);
    const rootMost =
      wing.mode === "treeLeft"
        ? nodes.reduce((acc, n) => (n.tier > acc.tier ? n : acc), nodes[0]) // layout root is outermost there
        : nodes[0];
    const merged = makeWNode(mergedKey, "", undefined, nodes[0].tier);
    merged.stub = true;
    merged.label = "";
    merged.unreachable = false;
    merged.parentKey = rootMost.parentKey;
    merged.members = nodes.map((n) => n.label).sort((a, b) => a.localeCompare(b));
    for (const k of members) {
      keyMap.set(k, mergedKey);
      wing.nodes.delete(k);
    }
    wing.nodes.set(mergedKey, merged);
  });
  for (const [, m] of components) {
    if (m.length === 1) {
      const n = wing.nodes.get(m[0]) as WNode;
      n.members = [n.label];
    }
  }

  // Rewire edges and layout parents through the key map.
  const remap = (k: string) => keyMap.get(k) ?? k;
  const rewired = new Map<string, WEdge>();
  for (const e of wing.edges.values()) {
    const from = remap(e.from);
    const to = remap(e.to);
    if (from === to && (keyMap.has(e.from) || keyMap.has(e.to))) continue; // merge-created self-loop
    const key = edgeKey(from, to);
    const existing = rewired.get(key);
    if (existing) existing.sites.push(...e.sites);
    else rewired.set(key, { from, to, sites: e.sites });
  }
  wing.edges = rewired;
  for (const n of wing.nodes.values()) {
    if (n.parentKey !== undefined && n.parentKey !== "C") n.parentKey = remap(n.parentKey);
  }
}

function min(keys: string[]): string {
  return keys.reduce((a, b) => (b < a ? b : a));
}

// ── Stage 7: row ordering + positions ───────────────────────────────────────

function orderAndPlace(wing: Wing, options: ButterflyOptions): void {
  // Per-wing fallback: call-site sort means nothing on a merged-graph wing
  // with collapsed duplicates.
  let sort = options.sort;
  if (sort === "callSite" && wing.mode === "graph" && options.dupEdges !== "expand") sort = "alpha";

  if (wing.mode === "graph") placeGraphWing(wing, sort);
  else placeTreeWing(wing, sort);
}

function labelOrder(a: WNode, b: WNode): number {
  const stub = Number(a.stub) - Number(b.stub);
  if (stub !== 0) return stub; // stubs sort after labeled nodes
  const la = a.stub ? a.members.join(",") : a.label.toLowerCase();
  const lb = b.stub ? b.members.join(",") : b.label.toLowerCase();
  return la.localeCompare(lb) || a.key.localeCompare(b.key);
}

function placeGraphWing(wing: Wing, sort: SortMode): void {
  const columns = new Map<number, WNode[]>();
  for (const n of wing.nodes.values()) {
    const col = columns.get(n.tier);
    if (col) col.push(n);
    else columns.set(n.tier, [n]);
  }
  const tiers = [...columns.keys()].sort((a, b) => a - b);
  for (const t of tiers) columns.get(t)?.sort(labelOrder);

  // Centered position of a node given its current index within its column.
  const pos = new Map<string, number>();
  pos.set("C", 0);
  const refreshPos = () => {
    for (const t of tiers) {
      const col = columns.get(t) as WNode[];
      col.forEach((n, i) => pos.set(n.key, i - (col.length - 1) / 2));
    }
  };
  refreshPos();

  // Neighbor keys per node (both directions, self-loops excluded).
  const neighbors = new Map<string, Set<string>>();
  for (const e of wing.edges.values()) {
    if (e.from === e.to) continue;
    if (e.from !== "C" || e.to !== "C") {
      let s = neighbors.get(e.from);
      if (!s) neighbors.set(e.from, (s = new Set()));
      s.add(e.to);
      let s2 = neighbors.get(e.to);
      if (!s2) neighbors.set(e.to, (s2 = new Set()));
      s2.add(e.from);
    }
  }
  const tierOf = (key: string): number => (key === "C" ? 0 : (wing.nodes.get(key)?.tier ?? 0));

  if (sort === "minCross") {
    // Barycenter heuristic, fixed two-sweep schedule (deterministic).
    const sweep = (order: number[], refSide: "inner" | "outer") => {
      for (const t of order) {
        const col = columns.get(t) as WNode[];
        const bary = new Map<string, number>();
        for (const n of col) {
          const refs = [...(neighbors.get(n.key) ?? [])].filter((k) =>
            refSide === "inner" ? tierOf(k) < t : tierOf(k) > t
          );
          bary.set(n.key, refs.length > 0 ? refs.reduce((s, k) => s + (pos.get(k) ?? 0), 0) / refs.length : (pos.get(n.key) ?? 0));
        }
        col.sort(
          (a, b) =>
            (bary.get(a.key) as number) - (bary.get(b.key) as number) || labelOrder(a, b)
        );
        refreshPos();
      }
    };
    sweep(tiers, "inner");
    sweep([...tiers].reverse(), "outer");
  } else if (sort === "callSite") {
    // Outward sweep: follow the lowest-placed inner neighbor, then the line
    // of the call site shared with it — reads like source order.
    for (const t of tiers) {
      const col = columns.get(t) as WNode[];
      const rank = new Map<string, [number, number]>();
      for (const n of col) {
        const inner = [...(neighbors.get(n.key) ?? [])].filter((k) => tierOf(k) < t);
        if (inner.length === 0) {
          rank.set(n.key, [Number.MAX_SAFE_INTEGER, 0]);
          continue;
        }
        const best = inner.reduce((a, b) => ((pos.get(a) ?? 0) <= (pos.get(b) ?? 0) ? a : b));
        let minLine = Number.MAX_SAFE_INTEGER;
        for (const e of wing.edges.values()) {
          const touches = (e.from === n.key && e.to === best) || (e.to === n.key && e.from === best);
          if (!touches) continue;
          for (const s of e.sites) minLine = Math.min(minLine, s.e.line);
        }
        rank.set(n.key, [pos.get(best) ?? 0, minLine]);
      }
      col.sort((a, b) => {
        const ra = rank.get(a.key) as [number, number];
        const rb = rank.get(b.key) as [number, number];
        return ra[0] - rb[0] || ra[1] - rb[1] || labelOrder(a, b);
      });
      refreshPos();
    }
  }

  for (const t of tiers) {
    const col = columns.get(t) as WNode[];
    col.forEach((n, i) => {
      n.row = i - (col.length - 1) / 2;
    });
  }
}

function placeTreeWing(wing: Wing, sort: SortMode): void {
  const children = new Map<string, WNode[]>();
  const roots: WNode[] = [];
  for (const n of wing.nodes.values()) {
    const p = n.parentKey;
    if (p === undefined || p === "C") {
      roots.push(n);
      continue;
    }
    const list = children.get(p);
    if (list) list.push(n);
    else children.set(p, [n]);
  }

  /** Min call-site line on the bundle between a node and its layout parent —
   *  source order under that parent. */
  const lineToParent = (n: WNode): number => {
    const p = n.parentKey === undefined ? "C" : n.parentKey;
    let best = Number.MAX_SAFE_INTEGER;
    for (const candidate of [wing.edges.get(edgeKey(n.key, p)), wing.edges.get(edgeKey(p, n.key))]) {
      if (!candidate) continue;
      for (const s of candidate.sites) best = Math.min(best, s.e.line);
    }
    return best;
  };
  const cmp =
    sort === "callSite"
      ? (a: WNode, b: WNode) => lineToParent(a) - lineToParent(b) || labelOrder(a, b)
      : labelOrder;
  roots.sort(cmp);
  for (const list of children.values()) list.sort(cmp);

  // Tidy layout: leaves take sequential rows, a parent centers on its
  // first/last child. All roots share the leaf counter.
  let nextLeaf = 0;
  const visit = (n: WNode): void => {
    const kids = children.get(n.key);
    if (!kids || kids.length === 0) {
      n.row = nextLeaf++;
      return;
    }
    for (const k of kids) visit(k);
    n.row = (kids[0].row + kids[kids.length - 1].row) / 2;
  };
  for (const r of roots) visit(r);

  // Balance the wing around the center: tree mode centers on the virtual
  // root's row; treeLeft centers on the mean of the center-adjacent nodes.
  let shift = 0;
  if (wing.mode === "tree") {
    if (roots.length > 0) shift = (roots[0].row + roots[roots.length - 1].row) / 2;
  } else {
    const terminals: WNode[] = [];
    for (const e of wing.edges.values()) {
      const key = wing.side === "caller" ? (e.to === "C" ? e.from : undefined) : e.from === "C" ? e.to : undefined;
      if (key === undefined) continue;
      const n = wing.nodes.get(key);
      if (n) terminals.push(n);
    }
    if (terminals.length > 0) shift = terminals.reduce((s, n) => s + n.row, 0) / terminals.length;
  }
  for (const n of wing.nodes.values()) n.row -= shift;
}

// ── Stage 8: emit ───────────────────────────────────────────────────────────

function emit(
  center: SymbolRecord,
  centerId: string,
  wings: Wing[],
  options: ButterflyOptions
): { nodes: ButterflyNode[]; edges: ButterflyEdge[] } {
  const nodes: ButterflyNode[] = [
    {
      elId: "C",
      symbolId: centerId,
      label: options.label === "type" ? formatSignature(center) : center.name,
      kind: center.kind,
      ownerClass: center.ownerClass,
      side: "center",
      tier: 0,
      row: 0
    }
  ];
  const edges: ButterflyEdge[] = [];

  for (const wing of wings) {
    for (const n of wing.nodes.values()) {
      const baseLabel = n.stub ? "" : options.label === "type" && n.sym ? formatSignature(n.sym) : n.label;
      nodes.push({
        elId: n.key,
        symbolId: n.stub ? "" : n.symbolId,
        label: n.recursive && !n.stub ? `${baseLabel} ↻` : baseLabel,
        kind: n.sym ? n.sym.kind : SymbolKind.Unresolved,
        ownerClass: n.sym?.ownerClass,
        side: wing.side,
        tier: n.tier,
        row: n.row,
        ...(n.stub ? { stub: true, hiddenLabels: n.members } : {}),
        ...(!n.stub && n.unreachable && options.unreachable === "gray" ? { unreachable: true } : {}),
        ...(n.recursive && !n.stub ? { recursive: true } : {})
      });
    }
    const wingEdges = [...wing.edges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    for (const e of wingEdges) {
      const sites = [...e.sites].sort((a, b) => a.e.line - b.e.line || (a.e.column ?? 0) - (b.e.column ?? 0));
      if (options.dupEdges === "expand") {
        for (const s of sites) {
          edges.push({
            id: `e${edges.length}`,
            source: e.from,
            target: e.to,
            kind: s.e.callKind,
            resolved: s.e.resolved,
            ...(s.unreachable && options.unreachable === "gray" ? { unreachable: true } : {}),
            line: s.e.line + 1
          });
        }
      } else {
        const first = sites[0];
        edges.push({
          id: `e${edges.length}`,
          source: e.from,
          target: e.to,
          kind: first.e.callKind,
          resolved: first.e.resolved,
          ...(sites.every((s) => s.unreachable) && options.unreachable === "gray" ? { unreachable: true } : {})
        });
      }
    }
  }
  return { nodes, edges };
}
