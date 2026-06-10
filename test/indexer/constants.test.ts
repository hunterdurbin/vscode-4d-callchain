import { beforeAll, expect, it } from "vitest";
import { describeWithFixture } from "../helpers/fixture";
import { callersOf, getSharedIndex, symFinder } from "../helpers/sharedIndex";
import type { SymbolIndex } from "../../packages/core/dist";

// Mini-floor caller counts. A large project has many more; we just need ≥1 to
// prove the constant gets wired up via ConstantRef edges.
// expectedLine is the zero-based line of the constant's <source> tag in
// Constants_Project.xlf (1-based source line minus one).
const CONST_SAMPLES = [
  { name: "_Rules",                  expectedType: "Text",    expectedValue: "Rules",              minCallers: 1, expectedLine: 20 },
  { name: "Worker_Backend",          expectedType: "Longint", expectedValue: "1",                  minCallers: 1, expectedLine: 25 },
  { name: "MODULE_INVOICES",         expectedType: "Text",    expectedValue: "Invoices",           minCallers: 1, expectedLine: 33 },
  { name: "4X_TYPE_SAMPLE",          expectedType: "Text",    expectedValue: "sample_type",        minCallers: 1, expectedLine: 38 }
] as const;

describeWithFixture("indexer/constants — user-defined constants", (root) => {
  let idx: SymbolIndex;
  let sym: ReturnType<typeof symFinder>;

  beforeAll(async () => {
    idx = await getSharedIndex(root);
    sym = symFinder(idx);
  });

  for (const probe of CONST_SAMPLES) {
    it(`${probe.name}: indexed with correct value/type and ≥${probe.minCallers} callers`, () => {
      const c = sym("Constant", probe.name) as any;
      expect(c).toBeTruthy();
      if (!c) return;
      expect(c.constantValue).toBe(probe.expectedValue);
      expect(c.constantType).toBe(probe.expectedType);
      expect(callersOf(idx, c).length).toBeGreaterThanOrEqual(probe.minCallers);
      // Real <source> line from the XLF, not a stub 0.
      expect(c.location.line).toBe(probe.expectedLine);
    });
  }
});
