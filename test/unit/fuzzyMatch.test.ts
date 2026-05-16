import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "../../packages/core/dist";

describe("fuzzyMatch", () => {
  it("matches characters in order, case-insensitively", () => {
    expect(fuzzyMatch("calcrec", "IQ_CalculateRecord")).toBe(true);
    expect(fuzzyMatch("CALC", "iq_calculaterecord")).toBe(true);
  });

  it("returns false when chars appear out of order", () => {
    expect(fuzzyMatch("dcba", "abcd")).toBe(false);
  });

  it("returns false when a char is missing from the target", () => {
    expect(fuzzyMatch("xyz", "abcd")).toBe(false);
  });

  it("matches empty query against anything", () => {
    expect(fuzzyMatch("", "anything")).toBe(true);
    expect(fuzzyMatch("", "")).toBe(true);
  });

  it("non-empty query against empty target is false", () => {
    expect(fuzzyMatch("x", "")).toBe(false);
  });

  it("substring queries match", () => {
    expect(fuzzyMatch("user", "getUserById")).toBe(true);
    expect(fuzzyMatch("gubi", "getUserById")).toBe(true);
  });
});
