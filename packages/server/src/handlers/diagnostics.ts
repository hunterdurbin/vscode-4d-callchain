import * as fs from "fs";
import {
  Connection,
  Diagnostic,
  DiagnosticSeverity,
  Range,
  TextDocuments
} from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { CallEdge, SymbolKind } from "@4d/core";
import { ServerState } from "../state";
import { runRules } from "../lint/runner";

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
export function registerDiagnostics(
  state: ServerState,
  documents: TextDocuments<TextDocument>
): {
  publishForFile: (uri: string) => void;
  publishForAllSymbols: () => void;
  clearForFile: (uri: string) => void;
} {
  const connection: Connection = state.connection;

  /**
   * Fetch source text for a URI — live content from `documents` when the
   * file is open in the editor, falling back to disk. Returns undefined
   * only when neither path produces content (file deleted, unreadable).
   */
  const readSource = (uri: string): string | undefined => {
    const doc = documents.get(uri);
    if (doc) return doc.getText();
    try {
      return fs.readFileSync(URI.parse(uri).fsPath, "utf8");
    } catch {
      return undefined;
    }
  };

  /**
   * Run all enabled lint rules for `uri` and return the diagnostics.
   * Skips when no rules are enabled (the common case until the user opts
   * in) so we don't pay the source-read cost.
   */
  const lintDiagnostics = (uri: string): Diagnostic[] => {
    const config = state.lintConfig;
    // Quick exit when no rules are enabled — covers the default state.
    let anyEnabled = false;
    for (const v of Object.values(config)) {
      if (v === "off" || v === undefined) continue;
      if (typeof v === "string") { anyEnabled = true; break; }
      if (typeof v === "object" && v !== null) {
        const sev = (v as { severity?: string }).severity;
        if (sev && sev !== "off") { anyEnabled = true; break; }
      }
    }
    if (!anyEnabled) return [];
    const source = readSource(uri);
    if (source === undefined) return [];
    const absolutePath = URI.parse(uri).fsPath;
    const parsed = state.indexer?.getParsedFile(absolutePath);
    return runRules({
      uri,
      source,
      parsed,
      callGraph: state.graph,
      config
    });
  };

  // Internal: emit diagnostics for one URI given its already-filtered symbol
  // list. The bulk `publishForAllSymbols` pre-buckets symbols by URI in one
  // O(N) pass and reuses this helper, avoiding the previous
  // O(URIs × allSymbols) re-scan.
  const publishSymbols = (uri: string, symbols: Iterable<{ id: string; kind: SymbolKind }>): number => {
    const graph = state.graph;
    if (!graph) return 0;
    const diags: Diagnostic[] = [];
    const seen = new Set<string>();
    for (const sym of symbols) {
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
    // Append lint findings (source: "4d-lint") so both diagnostic kinds
    // flow through the same publish path and the user only sees one
    // Problems-panel update per file.
    for (const d of lintDiagnostics(uri)) diags.push(d);
    connection.sendDiagnostics({ uri, diagnostics: diags });
    return diags.length;
  };

  const publishForFile = (uri: string) => {
    const graph = state.graph;
    if (!graph) return;
    const t0 = Date.now();
    // Single-URI publish: scan all symbols once filtering on URI. This is
    // the warm/edit path, called once per save — the project-wide bulk
    // path uses `publishForAllSymbols` which buckets first.
    const fileSymbols: Array<{ id: string; kind: SymbolKind }> = [];
    for (const sym of graph.allSymbols()) {
      if (sym.location.uri === uri) fileSymbols.push(sym);
    }
    const count = publishSymbols(uri, fileSymbols);
    const elapsed = Date.now() - t0;
    if (elapsed >= SLOW_PUBLISH_MS) {
      connection.console.info(`[Diagnostics] publishForFile ${uri} took ${elapsed}ms (${count} diags)`);
    }
  };

  const publishForAllSymbols = () => {
    const graph = state.graph;
    if (!graph) return;
    const t0 = Date.now();
    // Pre-bucket symbols by URI in one pass — without this we'd scan all
    // graph.allSymbols() once per URI (O(URIs × symbols) ≈ N² for large
    // projects: ~625M iterations on a 25k-file project).
    const byUri = new Map<string, Array<{ id: string; kind: SymbolKind }>>();
    for (const sym of graph.allSymbols()) {
      const uri = sym.location.uri;
      if (!uri) continue;
      let list = byUri.get(uri);
      if (!list) { list = []; byUri.set(uri, list); }
      list.push(sym);
    }
    for (const [uri, syms] of byUri) publishSymbols(uri, syms);
    const elapsed = Date.now() - t0;
    if (elapsed >= SLOW_PUBLISH_MS) {
      connection.console.info(`[Diagnostics] publishForAllSymbols across ${byUri.size} URIs took ${elapsed}ms`);
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
