import { describe, expect, it } from "vitest";
import { cleanLine, recoverString, stripBlockComments } from "../../packages/core/dist";

describe("cleanLine", () => {
  it("strips trailing single-line comments", () => {
    const { text } = cleanLine("$x := 1  // a comment");
    expect(text).toBe("$x := 1  ");
  });

  it("strips backtick single-line comments (4D v18+)", () => {
    // Anywhere a `` ` `` appears, the rest of the line is a comment. Found in
    // legacy code as inline author / behavior annotations like
    // `` `assumes there is a record loaded in classic for $table ``.
    const { text } = cleanLine("` assumes there is a record loaded in classic for $table");
    expect(text).toBe("");
  });

  it("backtick comment in the middle of a line truncates from the backtick", () => {
    const { text } = cleanLine("$x := 1  ` annotation");
    expect(text).toBe("$x := 1  ");
  });

  it("removes block comments inline", () => {
    const { text } = cleanLine("$x := /* skip me */ 1");
    expect(text).toBe("$x :=  1");
  });

  it("replaces string literals with sentinels and captures contents", () => {
    const { text, strings } = cleanLine('CALL WORKER("worker"; "Foo")');
    expect(text).toBe('CALL WORKER("0"; "1")');
    expect(strings).toEqual(["worker", "Foo"]);
  });

  it("handles escaped quotes (doubled \"\") inside strings", () => {
    const { text, strings } = cleanLine('$s := "she said ""hi"" loud"');
    expect(text).toBe('$s := "0"');
    expect(strings).toEqual(['she said "hi" loud']);
  });

  it("`cols` maps output positions back to input columns", () => {
    const input = "$x := 1  // comment";
    const { text, cols } = cleanLine(input);
    // Output is "$x := 1  ". Each output char should map to its input column.
    expect(text).toBe("$x := 1  ");
    expect(cols.length).toBe(text.length + 1);
    expect(cols[0]).toBe(0);     // "$"
    expect(cols[1]).toBe(1);     // "x"
    expect(cols[6]).toBe(6);     // "1"
  });

  it("recoverString resolves a sentinel back to the original literal", () => {
    const { text, strings } = cleanLine('CALL WORKER("w"; "Foo")');
    const sentinel = text.match(/"\d+"/g)![1];
    expect(recoverString(text, strings, sentinel)).toBe("Foo");
  });
});

describe("stripBlockComments", () => {
  it("blanks out single-line block comments while preserving char count", () => {
    const out = stripBlockComments("$x := /* hi */ 1");
    expect(out).toBe("$x :=          1");
  });

  it("preserves newlines inside multi-line block comments", () => {
    const out = stripBlockComments("a /*\n still in comment\n*/ b");
    // Original had two `\n` inside the block — they must survive so line
    // counts stay aligned with the source.
    expect(out.split("\n").length).toBe(3);
    expect(out.endsWith("b")).toBe(true);
  });
});
