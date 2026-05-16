import { beforeAll, expect, it } from "vitest";
import { describeWithFixture } from "../helpers/fixture";
import { callersOf, getSharedIndex, symFinder } from "../helpers/sharedIndex";
import type { SymbolIndex } from "../../packages/core/dist";

// Mini-floor caller counts. Symphony has many more; we just need ≥1 to
// prove the constant gets wired up via ConstantRef edges.
const CONST_SAMPLES = [
  { name: "_Rules",                  expectedType: "Text",    expectedValue: "Rules",              minCallers: 1 },
  { name: "Worker_Backend",          expectedType: "Longint", expectedValue: "1",                  minCallers: 1 },
  { name: "MODULE_INVOICES",         expectedType: "Text",    expectedValue: "Invoices",           minCallers: 1 },
  { name: "4Q_TYPE_AuditCreditCards",expectedType: "Text",    expectedValue: "audit_credit_cards", minCallers: 1 }
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
    });
  }
});
