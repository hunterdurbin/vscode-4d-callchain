import { beforeAll, expect, it } from "vitest";
import * as path from "path";
import { describeWithFixture } from "../helpers/fixture";

const treeSitter = require("../../packages/core/dist/parser/parseWithTreeSitter");

const MINI_FIXTURE_BASENAME = "mini-4d";

describeWithFixture(
  "indexer/lint-usage — Phase A ParsedFile fields",
  (root) => {
    const isMini = root.endsWith(MINI_FIXTURE_BASENAME);
    let parsed: any;

    beforeAll(async () => {
      if (!isMini) return;
      await treeSitter.initTreeSitterParser();
      const absolutePath = path.join(
        root,
        "Project",
        "Sources",
        "Methods",
        "Lint_UsageProbe.4dm"
      );
      parsed = treeSitter.parseFileWithTreeSitter({
        absolutePath,
        relativePath: "Project/Sources/Methods/Lint_UsageProbe.4dm",
        category: "method"
      });
    });

    it("exposes localReads / localWrites / localDeclMode on ParsedFile", () => {
      if (!isMini) return;
      expect(parsed.localReads).toBeInstanceOf(Map);
      expect(parsed.localWrites).toBeInstanceOf(Map);
      expect(parsed.localDeclMode).toBeInstanceOf(Map);
    });

    it("records bodySpan on the project method symbol", () => {
      if (!isMini) return;
      const probe = parsed.symbols.find(
        (s: any) => s.name === "Lint_UsageProbe"
      );
      expect(probe).toBeTruthy();
      expect(probe.bodySpan).toBeTruthy();
      // File-level symbol — body covers the whole file.
      expect(probe.bodySpan.startLine).toBe(0);
      expect(probe.bodySpan.endLine).toBeGreaterThan(10);
    });

    it("captures declared params as declared (read or not)", () => {
      if (!isMini) return;
      const probe = parsed.symbols.find(
        (s: any) => s.name === "Lint_UsageProbe"
      );
      const declMode = parsed.localDeclMode.get(probe.id);
      expect(declMode.get("declaredParam")).toBe("declared");
      expect(declMode.get("unusedParam")).toBe("declared");
    });

    it("captures `var $x : T` as declared", () => {
      if (!isMini) return;
      const probe = parsed.symbols.find(
        (s: any) => s.name === "Lint_UsageProbe"
      );
      const declMode = parsed.localDeclMode.get(probe.id);
      expect(declMode.get("declaredLocal")).toBe("declared");
      expect(declMode.get("declaredButUnread")).toBe("declared");
    });

    it("captures #DECLARE return name as declared", () => {
      if (!isMini) return;
      const probe = parsed.symbols.find(
        (s: any) => s.name === "Lint_UsageProbe"
      );
      const declMode = parsed.localDeclMode.get(probe.id);
      expect(declMode.get("result")).toBe("declared");
    });

    it("flags first-write-with-no-prior-decl as implicit", () => {
      if (!isMini) return;
      const probe = parsed.symbols.find(
        (s: any) => s.name === "Lint_UsageProbe"
      );
      const declMode = parsed.localDeclMode.get(probe.id);
      expect(declMode.get("implicitLocal")).toBe("implicit");
    });

    it("records reads for every used local + param", () => {
      if (!isMini) return;
      const probe = parsed.symbols.find(
        (s: any) => s.name === "Lint_UsageProbe"
      );
      const reads = parsed.localReads.get(probe.id);
      expect(reads.has("declaredParam")).toBe(true);
      expect(reads.has("declaredLocal")).toBe(true);
      expect(reads.has("implicitLocal")).toBe(true);
      // $result is referenced both as a write target (left of `:=`) and
      // as a read (right of `:=`, plus `return $result`).
      expect(reads.has("result")).toBe(true);
      // Each read array carries at least one position record.
      const declaredParamReads = reads.get("declaredParam");
      expect(Array.isArray(declaredParamReads)).toBe(true);
      expect(declaredParamReads.length).toBeGreaterThanOrEqual(1);
      expect(typeof declaredParamReads[0].line).toBe("number");
      expect(typeof declaredParamReads[0].column).toBe("number");
      expect(typeof declaredParamReads[0].endColumn).toBe("number");
    });

    it("does NOT record reads for unused params or write-only locals", () => {
      if (!isMini) return;
      const probe = parsed.symbols.find(
        (s: any) => s.name === "Lint_UsageProbe"
      );
      const reads = parsed.localReads.get(probe.id);
      expect(reads.has("unusedParam")).toBe(false);
      expect(reads.has("declaredButUnread")).toBe(false);
    });

    it("records writes for every assignment target AND var-decl site", () => {
      if (!isMini) return;
      const probe = parsed.symbols.find(
        (s: any) => s.name === "Lint_UsageProbe"
      );
      const writes = parsed.localWrites.get(probe.id);
      expect(writes.has("implicitLocal")).toBe(true);
      // `var $declaredLocal : Text` registers a declaration-site write so
      // `unused/local` can flag declared-but-never-used vars even without
      // any subsequent assignment. The fixture also assigns to it later,
      // so two write sites total.
      expect(writes.has("declaredLocal")).toBe(true);
      expect(writes.get("declaredLocal").length).toBe(2);
      expect(writes.has("declaredButUnread")).toBe(true);
      // $result is assigned twice in the fixture body.
      const resultWrites = writes.get("result");
      expect(resultWrites.length).toBe(2);
    });

    it("does NOT record writes for params (no assignment) or pure-read names", () => {
      if (!isMini) return;
      const probe = parsed.symbols.find(
        (s: any) => s.name === "Lint_UsageProbe"
      );
      const writes = parsed.localWrites.get(probe.id);
      expect(writes.has("declaredParam")).toBe(false);
      expect(writes.has("unusedParam")).toBe(false);
    });
  }
);
