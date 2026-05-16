import { describe, expect, it } from "vitest";
import { scanBlocks } from "../../packages/core/dist";

describe("scanBlocks", () => {
  it("emits an if block spanning its If/End if", () => {
    const src = [
      "If ($x = 1)",
      "  $y := 2",
      "End if"
    ].join("\n");
    const blocks = scanBlocks(src);
    expect(blocks).toContainEqual({ kind: "if", startLine: 0, endLine: 2 });
  });

  it("emits case / for / while / repeat blocks", () => {
    const src = [
      "Case of",
      "  : ($x = 1)",
      "End case",
      "For ($i; 1; 10)",
      "  $sum := $sum + $i",
      "End for",
      "While ($cond)",
      "  $cond := False",
      "End while",
      "Repeat",
      "  $n := $n + 1",
      "Until ($n > 3)"
    ].join("\n");
    const blocks = scanBlocks(src);
    const kinds = blocks.map((b) => b.kind).sort();
    expect(kinds).toEqual(["case", "for", "repeat", "while"]);
  });

  it("emits function blocks AND a class wrapper when class members are present", () => {
    const src = [
      "Function getFoo : Text",
      "  return \"foo\"",
      "",
      "Function getBar : Text",
      "  return \"bar\""
    ].join("\n");
    const blocks = scanBlocks(src);
    const functions = blocks.filter((b) => b.kind === "function");
    expect(functions.length).toBe(2);
    // First function closes one line before the second function header.
    expect(functions[0].startLine).toBe(0);
    expect(functions[0].endLine).toBe(2);
    expect(functions[1].startLine).toBe(3);
    // Class wrapper spans the whole file.
    expect(blocks).toContainEqual({ kind: "class", startLine: 0, endLine: 4 });
  });

  it("emits a function block for Class constructor", () => {
    const src = [
      "Class constructor",
      "  This.x := 1",
      "",
      "Function getX : Number",
      "  return This.x"
    ].join("\n");
    const blocks = scanBlocks(src);
    const functions = blocks.filter((b) => b.kind === "function");
    expect(functions.length).toBe(2);
  });

  it("ignores keywords inside comments and strings", () => {
    const src = [
      "$s := \"If (skipme)\"",
      "// If (also-skipme)",
      "If ($x)",
      "  $y := 1",
      "End if"
    ].join("\n");
    const blocks = scanBlocks(src);
    const ifs = blocks.filter((b) => b.kind === "if");
    expect(ifs.length).toBe(1);
    expect(ifs[0].startLine).toBe(2);
  });

  it("strips block comments before scanning", () => {
    const src = [
      "/* If ($fake)",
      "End if */",
      "If ($real)",
      "  $y := 1",
      "End if"
    ].join("\n");
    const blocks = scanBlocks(src);
    const ifs = blocks.filter((b) => b.kind === "if");
    expect(ifs.length).toBe(1);
    expect(ifs[0].startLine).toBe(2);
  });

  it("returns no blocks for empty input", () => {
    expect(scanBlocks("")).toEqual([]);
  });
});
