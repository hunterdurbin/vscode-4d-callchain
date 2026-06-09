import * as path from "path";
import { fileURLToPath } from "url";
import { CallEdge, CallGraph, SymbolRecord } from "@4d/core";

/**
 * Compact, agent-friendly view of a symbol. Drops internal-only fields and
 * converts the stored `file://` URI + zero-based line into a project-relative
 * path and a 1-based line (what editors and humans expect).
 */
export interface SymbolSummary {
  id: string;
  name: string;
  kind: string;
  ownerClass?: string;
  extendsClass?: string;
  signature?: string;
  /** For class members: `local`/`shared`/`public` visibility, when known. */
  scope?: "local" | "shared" | "public";
  /** For class members: `get`/`set`/`function` (and `query`/`orderBy` for ORDA), when known. */
  accessor?: "get" | "set" | "function";
  /** Path relative to the project root; omitted for synthetic symbols (builtins). */
  file?: string;
  /** 1-based line of the declaration; omitted for synthetic symbols. */
  line?: number;
}

/** A caller/callee edge with the connected symbol resolved to a summary. */
export interface EdgeSummary {
  symbol: SymbolSummary;
  /** 1-based line of the call site within the *source* (caller) file. */
  callLine: number;
  callKind: string;
  /** The raw call expression as it appears in source. */
  raw?: string;
  /** False when the target couldn't be resolved to a real declaration. */
  resolved: boolean;
}

/** Render a 4D-ish signature like `(name : Text; count : Integer) -> Object`. */
function signatureOf(s: SymbolRecord): string | undefined {
  if ((!s.params || s.params.length === 0) && !s.returnType) return undefined;
  const params = (s.params ?? [])
    .map((p) => {
      const prefix = p.variadic ? "..." : "";
      const type = p.type ? ` : ${p.type}` : "";
      return `${prefix}${p.name}${type}`;
    })
    .join("; ");
  const ret = s.returnType ? ` -> ${s.returnType}` : "";
  return `(${params})${ret}`;
}

function relPath(uri: string, projectRoot: string): string | undefined {
  if (!uri) return undefined;
  try {
    const abs = uri.startsWith("file://") ? fileURLToPath(uri) : uri;
    const rel = path.relative(projectRoot, abs);
    return rel.startsWith("..") ? abs : rel;
  } catch {
    return undefined;
  }
}

export function summarize(s: SymbolRecord, projectRoot: string): SymbolSummary {
  const file = relPath(s.location.uri, projectRoot);
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    ownerClass: s.ownerClass,
    extendsClass: s.extendsClass,
    signature: signatureOf(s),
    scope: s.scope,
    accessor: s.accessor,
    file,
    // Stored lines are zero-based; expose 1-based. Synthetic symbols (uri "")
    // get no line so agents don't chase a bogus location:1.
    line: file ? s.location.line + 1 : undefined
  };
}

/**
 * Summarize an edge from the perspective of "the other end". `self` is the
 * symbol being queried; `otherId` is the connected node (callee for a
 * find_callees row, caller for a find_callers row).
 */
export function summarizeEdge(
  edge: CallEdge,
  otherId: string,
  graph: CallGraph,
  projectRoot: string
): EdgeSummary {
  const other = graph.symbol(otherId);
  return {
    symbol: other
      ? summarize(other, projectRoot)
      : { id: otherId, name: otherId, kind: "Unknown" },
    callLine: edge.line + 1,
    callKind: edge.callKind,
    raw: edge.raw || undefined,
    resolved: edge.resolved
  };
}
