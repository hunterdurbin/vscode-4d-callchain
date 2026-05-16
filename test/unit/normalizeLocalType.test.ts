import { describe, expect, it } from "vitest";
import { normalizeLocalType } from "../../packages/core/dist";

describe("normalizeLocalType", () => {
  it("returns undefined for undefined input", () => {
    expect(normalizeLocalType(undefined)).toBeUndefined();
  });

  it("passes through cs.NS.Class unchanged", () => {
    expect(normalizeLocalType("cs.Billing.Invoice")).toBe("cs.Billing.Invoice");
  });

  it("strips the cs. prefix from a bare project class (cs.X → X)", () => {
    expect(normalizeLocalType("cs.Order")).toBe("Order");
  });

  it("converts entitySelectionOf:Table to EntitySelection<Table>", () => {
    expect(normalizeLocalType("entitySelectionOf:Orders")).toBe("EntitySelection<Orders>");
  });

  it("converts dsTableSelection:Table to EntitySelection<Table>", () => {
    expect(normalizeLocalType("dsTableSelection:Orders")).toBe("EntitySelection<Orders>");
  });

  it("applies tableToEntityClass for EntitySelection target", () => {
    expect(
      normalizeLocalType("entitySelectionOf:Orders", (t) =>
        t === "Orders" ? "Order" : undefined
      )
    ).toBe("EntitySelection<Order>");
  });

  it("dsTable:Table resolves via tableToEntityClass when provided", () => {
    expect(
      normalizeLocalType("dsTable:Orders", (t) =>
        t === "Orders" ? "Order" : undefined
      )
    ).toBe("Order");
    expect(normalizeLocalType("dsTable:Orders")).toBe("Orders");
  });

  it("canonicalizes primitive types", () => {
    expect(normalizeLocalType("Longint")).toBe("Number");
    expect(normalizeLocalType("Integer")).toBe("Number");
    expect(normalizeLocalType("Real")).toBe("Number");
    expect(normalizeLocalType("Alpha")).toBe("Text");
    expect(normalizeLocalType("String")).toBe("Text");
    expect(normalizeLocalType("Bool")).toBe("Boolean");
    expect(normalizeLocalType("Collection")).toBe("Collection");
    expect(normalizeLocalType("Object")).toBe("Object");
  });

  it("passes through pre-formed EntitySelection<X>", () => {
    expect(normalizeLocalType("EntitySelection<Order>")).toBe("EntitySelection<Order>");
  });

  it("returns unknown types unchanged", () => {
    expect(normalizeLocalType("MyClassName")).toBe("MyClassName");
  });
});
