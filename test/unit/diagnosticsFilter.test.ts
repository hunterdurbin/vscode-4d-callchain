import { describe, expect, it } from "vitest";
import { SymbolKind } from "../../packages/core/dist";

// `shouldSurface` lives in the language-server's diagnostics handler. The
// server package compiles to dist alongside core; reach into that build to
// avoid duplicating the rule table.
const { shouldSurface } = require("../../packages/server/dist/handlers/diagnostics");

describe("diagnostics.shouldSurface — caller-kind aware This.X handling", () => {
  it("surfaces a bare-name miss regardless of caller kind", () => {
    expect(shouldSurface("Foo", SymbolKind.ProjectMethod)).toBe(true);
    expect(shouldSurface("Foo", SymbolKind.ClassFunction)).toBe(true);
  });

  it("surfaces This.X when caller is a ClassFunction (real typo)", () => {
    expect(shouldSurface("This.bogus", SymbolKind.ClassFunction)).toBe(true);
    expect(shouldSurface("This.bogus", SymbolKind.ClassConstructor)).toBe(true);
  });

  it("suppresses This.X when caller is a ProjectMethod (`This` bound by Formula / form / callback)", () => {
    expect(shouldSurface("This.setProgress", SymbolKind.ProjectMethod)).toBe(false);
    expect(shouldSurface("This.size", SymbolKind.DatabaseMethod)).toBe(false);
    expect(shouldSurface("This.copy", SymbolKind.FormMethod)).toBe(false);
    expect(shouldSurface("This.copy", SymbolKind.FormObjectMethod)).toBe(false);
  });

  it("still suppresses multi-step This.X.Y regardless of caller kind", () => {
    expect(shouldSurface("This.foo.bar", SymbolKind.ClassFunction)).toBe(false);
    expect(shouldSurface("This.foo.bar", SymbolKind.ProjectMethod)).toBe(false);
    expect(shouldSurface("This.foo(", SymbolKind.ClassFunction)).toBe(false);
  });

  it("suppresses $var.X regardless of caller kind", () => {
    expect(shouldSurface("$x.bar", SymbolKind.ClassFunction)).toBe(false);
    expect(shouldSurface("$x.bar", SymbolKind.ProjectMethod)).toBe(false);
  });

  it("legacy single-arg call (no caller-kind) preserves old behavior — surfaces This.X", () => {
    // Without a caller kind, fall back to "single-step This is actionable",
    // matching the pre-change contract for callers that haven't been updated.
    expect(shouldSurface("This.bogus")).toBe(true);
    expect(shouldSurface("This.bogus.bar")).toBe(false);
  });
});
