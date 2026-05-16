import { describe, expect, it } from "vitest";
import { parseFilterQuery } from "../../packages/core/dist";

describe("parseFilterQuery", () => {
  it("returns empty fuzzy + no predicate for empty input", () => {
    const q = parseFilterQuery("");
    expect(q.fuzzy).toBe("");
    expect(q.excludes).toEqual([]);
    expect(q.callerPredicate).toBeUndefined();
    expect(q.callerDesc).toBeUndefined();
  });

  it("parses positive tokens into a joined fuzzy string", () => {
    const q = parseFilterQuery("braintree credit");
    expect(q.fuzzy).toBe("braintree credit");
    expect(q.excludes).toEqual([]);
  });

  it("captures excludes (-prefixed tokens)", () => {
    const q = parseFilterQuery("braintree -test -mock");
    expect(q.fuzzy).toBe("braintree");
    expect(q.excludes).toEqual(["test", "mock"]);
  });

  it("parses caller-count predicates: > < = >= <=", () => {
    expect(parseFilterQuery(">5").callerDesc).toBe(">5");
    expect(parseFilterQuery(">5").callerPredicate?.(6)).toBe(true);
    expect(parseFilterQuery(">5").callerPredicate?.(5)).toBe(false);

    expect(parseFilterQuery("<3").callerPredicate?.(2)).toBe(true);
    expect(parseFilterQuery("<3").callerPredicate?.(3)).toBe(false);

    expect(parseFilterQuery("=10").callerPredicate?.(10)).toBe(true);
    expect(parseFilterQuery("=10").callerPredicate?.(9)).toBe(false);

    expect(parseFilterQuery(">=10").callerPredicate?.(10)).toBe(true);
    expect(parseFilterQuery(">=10").callerPredicate?.(9)).toBe(false);

    expect(parseFilterQuery("<=10").callerPredicate?.(10)).toBe(true);
    expect(parseFilterQuery("<=10").callerPredicate?.(11)).toBe(false);
  });

  it("combines fuzzy, excludes, and caller predicate in one query", () => {
    const q = parseFilterQuery("braintree -test >5");
    expect(q.fuzzy).toBe("braintree");
    expect(q.excludes).toEqual(["test"]);
    expect(q.callerDesc).toBe(">5");
    expect(q.callerPredicate?.(6)).toBe(true);
  });

  it("treats a bare `-` as a positive token (length > 1 rule)", () => {
    const q = parseFilterQuery("-");
    expect(q.fuzzy).toBe("-");
    expect(q.excludes).toEqual([]);
  });
});
