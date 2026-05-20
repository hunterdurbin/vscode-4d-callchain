import { describe, expect, it } from "vitest";
import { SymbolKind } from "../../packages/core/dist";
import type { SymbolRecord } from "../../packages/core/dist";

// Test runs against the built dist; require it dynamically so we can pull
// `buildSymbolIndex` out without polluting the package's public surface.
const nameResolver = require("../../packages/core/dist/indexer/nameResolver");

function buildOneComponentIndex() {
  return nameResolver.buildSymbolIndex(
    "/tmp/proj",
    [], // no parsed .4dm files
    [], // no plugins
    new Set<string>(), // no catalog tables
    [], // no constants
    [], // no builtin constants
    [], // no variables
    [
      {
        name: "datetime-4d",
        bundlePath: "/tmp/proj/Components/datetime-4d.4dbase",
        zipPath: "/tmp/proj/Components/datetime-4d.4dbase/datetime-4d.4DZ",
        methods: ["Duration_New", "DateTime_Now"],
        classStoreName: "datetime",
        classes: [
          {
            name: "Duration",
            functions: ["add", "subtract"],
            hasConstructor: true,
            properties: { seconds: { className: "Number", componentName: "" } }
          },
          {
            name: "DateTime",
            functions: ["format"],
            hasConstructor: false,
            properties: {}
          }
        ]
      }
    ]
  ).index;
}

describe("component-class symbols (TODO #12 — line-only by design)", () => {
  const idx = buildOneComponentIndex();
  // Top-level Component bundle symbol — does NOT carry ownerComponent (it IS
  // the component). Every other symbol derived from the .4DZ (ComponentMethod,
  // Class, ClassFunction, ClassConstructor) carries `ownerComponent` so
  // downstream code can detect compiled-bundle origin.
  const bundleSym = idx.symbols.find((s: SymbolRecord) => s.kind === SymbolKind.Component);
  const childSyms: SymbolRecord[] = idx.symbols.filter((s: SymbolRecord) => !!s.ownerComponent);

  it("emits a Component bundle symbol per .4dbase", () => {
    expect(bundleSym?.name).toBe("datetime-4d");
    expect(bundleSym?.id).toBe("Component:datetime-4d");
  });

  it("emits ComponentMethod + Class + ClassFunction + ClassConstructor for each component", () => {
    const kinds = new Set(childSyms.map((s) => s.kind));
    expect(kinds.has(SymbolKind.ComponentMethod)).toBe(true);
    expect(kinds.has(SymbolKind.Class)).toBe(true);
    expect(kinds.has(SymbolKind.ClassFunction)).toBe(true);
    expect(kinds.has(SymbolKind.ClassConstructor)).toBe(true);
  });

  it("ids namespace component classes as cs.<classStoreName>.<ClassName>", () => {
    const durationCls = childSyms.find(
      (s) => s.kind === SymbolKind.Class && s.name === "Duration"
    );
    expect(durationCls?.id).toBe("Class:cs.datetime.Duration");
    const addFn = childSyms.find(
      (s) => s.kind === SymbolKind.ClassFunction && s.name === "add"
    );
    expect(addFn?.id).toBe("ClassFunction:cs.datetime.Duration.add");
    expect(addFn?.ownerClass).toBe("cs.datetime.Duration");
  });

  it("every component-derived symbol carries ownerComponent (the line-only marker)", () => {
    // ownerComponent is what downstream features (semantic tokens, rename,
    // hover) inspect to detect that a symbol came from a compiled .4DZ and
    // therefore has no source positions.
    for (const s of childSyms) {
      expect(s.ownerComponent).toBe("datetime-4d");
    }
  });

  it("location.column is undefined for every component-derived symbol (no source ships in .4DZ)", () => {
    const allFromBundle = [bundleSym, ...childSyms].filter(Boolean) as SymbolRecord[];
    for (const s of allFromBundle) {
      expect(s.location.column).toBeUndefined();
      expect(s.location.endColumn).toBeUndefined();
      expect(s.location.line).toBe(0);
    }
  });
});
