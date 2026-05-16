import { describe, expect, it } from "vitest";
import { findEnclosingFunction, inferLocals } from "../../packages/core/dist";

describe("inferLocals", () => {
  it("captures `var $x : Type` declarations", () => {
    const src = [
      "Function probe",
      "  var $col : Collection",
      "  var $obj : Object"
    ].join("\n");
    const locals = inferLocals(src, 0, 2);
    expect(locals.get("col")).toBe("Collection");
    expect(locals.get("obj")).toBe("Object");
  });

  it("captures cs.Foo from `:= cs.Foo.new(...)`", () => {
    const src = [
      "Function probe",
      "  $order := cs.Order.new()"
    ].join("\n");
    const locals = inferLocals(src, 0, 1);
    expect(locals.get("order")).toBe("cs.Order");
  });

  it("captures cs.NS.Foo from `:= cs.NS.Foo.new(...)`", () => {
    const src = [
      "Function probe",
      "  $svc := cs.Billing.Service.new()"
    ].join("\n");
    const locals = inferLocals(src, 0, 1);
    expect(locals.get("svc")).toBe("cs.Billing.Service");
  });

  it("captures dsTable from `:= ds.Foo.new(...)` and ds[_Foo].new()", () => {
    const src = [
      "Function probe",
      "  $r := ds.Rules.new()",
      "  $s := ds[_Rules].new()"
    ].join("\n");
    const locals = inferLocals(src, 0, 2);
    expect(locals.get("r")).toBe("dsTable:Rules");
    expect(locals.get("s")).toBe("dsTable:Rules");
  });

  it("captures entity selection from `:= ds.Foo.query(...)`", () => {
    const src = [
      "Function probe",
      "  $es := ds.Orders.query(\"id > 0\")"
    ].join("\n");
    const locals = inferLocals(src, 0, 1);
    expect(locals.get("es")).toBe("entitySelectionOf:Orders");
  });

  it("captures #DECLARE params with types", () => {
    const src = [
      "Function probe",
      "#DECLARE($a : Text; $b : Number; $c : cs.Order)"
    ].join("\n");
    const locals = inferLocals(src, 0, 1);
    expect(locals.get("a")).toBe("Text");
    expect(locals.get("b")).toBe("Number");
    expect(locals.get("c")).toBe("cs.Order");
  });

  it("captures params on the Function declaration line", () => {
    const src = [
      "Function probe($a : Text; $b : cs.Order) : Number",
      "  return 1"
    ].join("\n");
    const locals = inferLocals(src, 0, 1);
    expect(locals.get("a")).toBe("Text");
    expect(locals.get("b")).toBe("cs.Order");
  });

  it("maps legacy `C_LONGINT($a; $b)` to Number", () => {
    const src = [
      "Function probe",
      "  C_LONGINT($n; $m)",
      "  C_TEXT($s)"
    ].join("\n");
    const locals = inferLocals(src, 0, 2);
    expect(locals.get("n")).toBe("Number");
    expect(locals.get("m")).toBe("Number");
    expect(locals.get("s")).toBe("Text");
  });

  it("ignores assignments inside string literals", () => {
    const src = [
      "Function probe",
      "  $note := \"$fake := cs.Order.new()\""
    ].join("\n");
    const locals = inferLocals(src, 0, 1);
    expect(locals.has("fake")).toBe(false);
  });
});

describe("findEnclosingFunction", () => {
  it("finds the function header above the cursor", () => {
    const src = [
      "Function first()",        // 0
      "  $x := 1",               // 1
      "",                        // 2
      "Function second()",       // 3
      "  $y := 2",               // 4
      "  $z := 3"                // 5
    ].join("\n");
    expect(findEnclosingFunction(src, 1)).toEqual({ startLine: 0, endLine: 2 });
    expect(findEnclosingFunction(src, 5)).toEqual({ startLine: 3, endLine: 5 });
  });

  it("treats the whole file as one scope when no Function header exists", () => {
    const src = [
      "$x := 1",
      "$y := 2"
    ].join("\n");
    expect(findEnclosingFunction(src, 1)).toEqual({ startLine: 0, endLine: 1 });
  });
});
