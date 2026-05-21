import {
  Connection,
  Diagnostic,
  DiagnosticSeverity,
  Range
} from "vscode-languageserver/node";
import { CallEdge, SymbolKind } from "@4d/core";
import { ServerState } from "../state";

const SOURCE = "4d";
const MAX_PER_FILE = 100;
// Threshold over which a single publishForFile / publishForAllSymbols call
// logs its elapsed time. Below this it stays quiet so we don't spam.
const SLOW_PUBLISH_MS = 100;

/**
 * Surface unresolved call edges as workspace warnings. Diagnostics are
 * server-pushed; no client capability flag is required.
 *
 * "Unresolved" means the resolver couldn't attribute a call site to a known
 * symbol — typically a typo'd method name, a reference to deleted code, or a
 * call into a class/component the index doesn't see. Resolved edges include
 * built-in 4D commands and plugin commands.
 */
export function registerDiagnostics(state: ServerState): {
  publishForFile: (uri: string) => void;
  publishForAllSymbols: () => void;
  clearForFile: (uri: string) => void;
} {
  const connection: Connection = state.connection;

  const publishForFile = (uri: string) => {
    const graph = state.graph;
    if (!graph) return;
    const t0 = Date.now();

    const diags: Diagnostic[] = [];
    const seen = new Set<string>();
    // Collect symbols defined in this file — their outgoing edges live in this file.
    for (const sym of graph.allSymbols()) {
      if (sym.location.uri !== uri) continue;
      for (const edge of graph.callees(sym.id)) {
        if (edge.resolved) continue;
        if (diags.length >= MAX_PER_FILE) break;
        const target = graph.symbol(edge.toId);
        // Skip if the resolver bucketed this into a synthetic Builtin/TableBuiltin —
        // those represent calls the resolver chose to treat as known (e.g. ORDA
        // .save / .first) and shouldn't surface as warnings.
        if (target && (target.kind === SymbolKind.Builtin || target.kind === SymbolKind.TableBuiltin)) continue;
        if (!shouldSurface(target?.name, sym.kind)) continue;
        const range = edgeRange(edge);
        const key = `${range.start.line}:${range.start.character}-${edge.toId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const message = describeUnresolved(edge, target?.name);
        diags.push({
          severity: DiagnosticSeverity.Warning,
          range,
          source: SOURCE,
          message,
          code: "unresolved-call"
        });
      }
    }
    connection.sendDiagnostics({ uri, diagnostics: diags });
    const elapsed = Date.now() - t0;
    if (elapsed >= SLOW_PUBLISH_MS) {
      connection.console.info(`[Diagnostics] publishForFile ${uri} took ${elapsed}ms (${diags.length} diags)`);
    }
  };

  const publishForAllSymbols = () => {
    const graph = state.graph;
    if (!graph) return;
    const t0 = Date.now();
    const uris = new Set<string>();
    for (const sym of graph.allSymbols()) {
      if (sym.location.uri) uris.add(sym.location.uri);
    }
    for (const uri of uris) publishForFile(uri);
    const elapsed = Date.now() - t0;
    if (elapsed >= SLOW_PUBLISH_MS) {
      connection.console.info(`[Diagnostics] publishForAllSymbols across ${uris.size} URIs took ${elapsed}ms`);
    }
  };

  const clearForFile = (uri: string) => {
    connection.sendDiagnostics({ uri, diagnostics: [] });
  };

  return { publishForFile, publishForAllSymbols, clearForFile };
}

function edgeRange(edge: CallEdge): Range {
  const startChar = edge.column ?? 0;
  const endChar = edge.endColumn ?? (edge.column !== undefined ? edge.column + 1 : 0);
  // Diagnostics with start == end render as a single-column hint in VSCode;
  // ensure we always have a non-empty range so the squiggle is visible.
  const end = endChar > startChar ? endChar : startChar + 1;
  return {
    start: { line: edge.line, character: startChar },
    end: { line: edge.line, character: end }
  };
}

function describeUnresolved(edge: CallEdge, calleeName: string | undefined): string {
  // The Unresolved symbol's name often carries the chain (e.g. `cs.Foo.bar` or
  // `$x.method` or `This.something`). Render a compact message.
  if (calleeName) return `Cannot resolve '${calleeName}'.`;
  return `Cannot resolve call: ${edge.raw}`;
}

/**
 * Filter out unresolved calls that are typically resolver limitations rather
 * than real typos. Without this, type-inferred-chain code drowns the Problems
 * panel.
 *
 * Surfaced (likely-real typos / actionable):
 *   - bare names ("Foo()")
 *   - `This.method` ONLY from inside a ClassFunction/ClassConstructor (the
 *     resolver knows the enclosing class, so a miss is a real typo)
 *   - `cs.X.method` / `cs.NS.X.method` (the resolver knows the class names)
 *   - `EXECUTE METHOD("Foo")` literal callees
 *
 * Suppressed (resolver limitations, not user-actionable):
 *   - `Super` (no-extends and synthetic-super noise)
 *   - `This.X.Y` / `This.X().Y` (multi-step chain — resolver can't walk)
 *   - `This.X` from inside a ProjectMethod / FormMethod / FormObjectMethod /
 *     etc. — `This` in those contexts is bound by the caller (Formula(...),
 *     form event, callback) and its class is unknowable. A miss isn't a typo.
 *   - `$x.<anything>` (local-type inference is best-effort; absent type ≠ typo)
 *   - `ds[X].method` (bracket-table access where the catalog scanner couldn't
 *     find the table — config issue, not user typo)
 */
export function shouldSurface(targetName: string | undefined, callerKind?: SymbolKind): boolean {
  if (!targetName) return true;
  if (targetName === "Super") return false;
  if (targetName.startsWith("ds[")) return false;
  // Dynamic method execution — `EXECUTE METHOD($var)` resolves at runtime, not
  // statically. The "unresolved" status is by design.
  if (targetName.startsWith("EXECUTE_METHOD(")) return false;

  // `This.<rest>` — skip multi-step chains.
  const thisMatch = targetName.match(/^This\.(.+)$/);
  if (thisMatch) {
    const rest = thisMatch[1];
    if (rest.includes(".") || rest.includes("(")) return false;
    // Single-step `This.X` is only actionable when the caller is a class
    // member (ClassFunction / ClassConstructor) — there the resolver knows
    // the class. Elsewhere (project methods, form methods, …) `This` is
    // bound dynamically by the caller (Formula / form / callback), so a
    // miss is a resolver limitation, not a typo.
    if (callerKind !== undefined &&
        callerKind !== SymbolKind.ClassFunction &&
        callerKind !== SymbolKind.ClassConstructor) {
      return false;
    }
    return true;
  }
  // `$var.<anything>` — local type wasn't captured; not actionable.
  if (/^\$[\w_]+\./.test(targetName)) return false;
  // Bare names, cs-qualified, ExecuteMethod literal callees, etc. — keep.
  return true;
}
