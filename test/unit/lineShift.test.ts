import { describe, it, expect } from "vitest";
import { applyContentChange, countNewlines } from "../../packages/vscode-client/src/codelens/lineShift";

/** Build a saved→current map seeded at the identity (clean document). */
function seed(...lines: number[]): Map<number, number> {
  return new Map(lines.map((l) => [l, l]));
}

describe("applyContentChange", () => {
  it("shifts markers below an insertion down by the lines added", () => {
    const m = seed(10, 20, 30);
    // Insert 2 blank lines at line 5 (a pure insertion: range is empty).
    applyContentChange(m, 5, 5, 2);
    expect([m.get(10), m.get(20), m.get(30)]).toEqual([12, 22, 32]);
  });

  it("leaves markers above the change untouched", () => {
    const m = seed(3, 40);
    applyContentChange(m, 20, 20, 5);
    expect(m.get(3)).toBe(3);
    expect(m.get(40)).toBe(45);
  });

  it("shifts markers up when lines are deleted above them", () => {
    const m = seed(50);
    // Delete 3 lines (range spans lines 10..13, replaced by nothing).
    applyContentChange(m, 10, 13, 0);
    expect(m.get(50)).toBe(47);
  });

  it("does not move a marker inside the changed region", () => {
    const m = seed(11);
    // Edit spans lines 10..12 and inserts one newline; marker at 11 is inside.
    applyContentChange(m, 10, 12, 1);
    expect(m.get(11)).toBe(11);
  });

  it("does not move a marker on the change's start line", () => {
    const m = seed(10);
    applyContentChange(m, 10, 10, 4);
    expect(m.get(10)).toBe(10);
  });

  it("is a no-op when the net delta is zero (single-line replace)", () => {
    const m = seed(5, 99);
    applyContentChange(m, 5, 5, 0);
    expect([m.get(5), m.get(99)]).toEqual([5, 99]);
  });

  it("stays consistent across multiple changes applied bottom-to-top", () => {
    const m = seed(10, 20, 30);
    // VS Code delivers contentChanges bottom-to-top within one event.
    applyContentChange(m, 25, 25, 3); // +3 below 25  -> 30 becomes 33
    applyContentChange(m, 5, 5, 1); //  +1 below 5  -> all three shift +1
    expect([m.get(10), m.get(20), m.get(30)]).toEqual([11, 21, 34]);
  });
});

describe("countNewlines", () => {
  it("counts \\n occurrences", () => {
    expect(countNewlines("")).toBe(0);
    expect(countNewlines("abc")).toBe(0);
    expect(countNewlines("\n")).toBe(1);
    expect(countNewlines("a\nb\nc")).toBe(2);
    expect(countNewlines("\n\n\n")).toBe(3);
  });
});
