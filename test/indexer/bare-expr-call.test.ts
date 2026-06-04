import { beforeAll, expect, it } from "vitest";
import * as path from "path";
import { describeWithFixture } from "../helpers/fixture";
import { buildTreeSitterIndex, initTreeSitter, isTreeSitterReady, parseWithTreeSitter } from "../helpers/treeSitterIndex";
import type { SymbolIndex } from "../../packages/core/dist";

// Locks in parenthesis-less project-method calls used in EXPRESSION position
// (`Not(Some_Method)`, `$x:=Some_Method`, …) — 4D's bare-call form nested
// inside an argument list / RHS, not alone on a line. The tree-sitter parser
// must emit a ProjectMethodBare for the inner identifier; the resolver keeps
// the edge iff a real method exists and drops it otherwise, so ordinary
// variable reads in the same position never become Unresolved noise.

const MINI_FIXTURE_BASENAME = "mini-4d";

describeWithFixture("indexer/bare-expr-call — paren-less calls in expression position", (root) => {
  const isMini = root.endsWith(MINI_FIXTURE_BASENAME);
  let idx: SymbolIndex;

  beforeAll(async () => {
    if (!isMini) return;
    await initTreeSitter();
    expect(isTreeSitterReady()).toBe(true);
    idx = buildTreeSitterIndex(root);
  });

  it("emits a ProjectMethodBare for a method invoked inside Not(...)", () => {
    if (!isMini) return;
    const absolutePath = path.join(
      root,
      "Project",
      "Sources",
      "Methods",
      "Bare_ParenLessCalls.4dm"
    );
    const parsed = parseWithTreeSitter({
      absolutePath,
      relativePath: "Project/Sources/Methods/Bare_ParenLessCalls.4dm",
      category: "method"
    });
    // The expression-position occurrence: a ProjectMethodBare for the target
    // on the `If (Not(...))` line (raw text carries the Not( context).
    const exprCall = parsed.rawCalls.find(
      (c: any) =>
        c.hint &&
        c.hint.kind === "ProjectMethodBare" &&
        c.hint.name === "Bare_ParenLessCalls_Target1" &&
        /Not\(/.test(c.raw)
    );
    expect(exprCall).toBeTruthy();
  });

  it("does NOT emit a ProjectMethodBare for the enclosing call's own function name", () => {
    if (!isMini) return;
    const absolutePath = path.join(
      root,
      "Project",
      "Sources",
      "Methods",
      "Bare_ParenLessCalls.4dm"
    );
    const parsed = parseWithTreeSitter({
      absolutePath,
      relativePath: "Project/Sources/Methods/Bare_ParenLessCalls.4dm",
      category: "method"
    });
    // `Not` is the callee of the call_expression — already classified as a
    // BareName by emitCall, so it must not also surface as a ProjectMethodBare.
    const notAsBare = parsed.rawCalls.find(
      (c: any) => c.hint && c.hint.kind === "ProjectMethodBare" && c.hint.name === "Not"
    );
    expect(notAsBare).toBeFalsy();
  });

  it("resolves the expression-position call to the sibling project method", () => {
    if (!isMini) return;
    const from = idx.symbols.find(
      (s: any) => s.kind === "ProjectMethod" && s.name === "Bare_ParenLessCalls"
    );
    expect(from).toBeTruthy();
    if (!from) return;
    const target = idx.symbols.find(
      (s: any) => s.kind === "ProjectMethod" && s.name === "Bare_ParenLessCalls_Target1"
    );
    expect(target).toBeTruthy();
    const edge = idx.edges.find((e) => e.fromId === from.id && e.toId === target!.id);
    expect(edge).toBeTruthy();
    expect(edge?.resolved).toBe(true);
  });

  it("a bare variable read in expression position does NOT leak an Unresolved edge", () => {
    if (!isMini) return;
    // `$x:=vBareExprProbeVar` reads an unknown identifier. ProjectMethodBare
    // is emitted but the resolver drops it (no matching method), so no edge
    // and no synthetic Unresolved symbol should mention the name.
    const probeSym = idx.symbols.find((s: any) => /vBareExprProbeVar/i.test(s.name));
    expect(probeSym).toBeFalsy();
    const probeEdge = idx.edges.find((e) => /vBareExprProbeVar/i.test(e.raw));
    expect(probeEdge).toBeFalsy();
  });
});
