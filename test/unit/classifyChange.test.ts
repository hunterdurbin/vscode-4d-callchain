import { describe, expect, it } from "vitest";
import * as path from "path";
import { classifyChange } from "../../packages/core/dist";

const ROOT = "/proj";
const p = (...parts: string[]) => path.join(ROOT, ...parts);

describe("classifyChange", () => {
  it("classifies Project/Sources/**/*.4dm as code", () => {
    expect(classifyChange(p("Project", "Sources", "Methods", "Foo.4dm"), ROOT)).toBe("code");
    expect(classifyChange(p("Project", "Sources", "Classes", "Bar.4dm"), ROOT)).toBe("code");
    expect(classifyChange(p("Project", "Sources", "Forms", "Login", "method.4dm"), ROOT)).toBe("code");
  });

  it("classifies Project/Sources/catalog.4DCatalog as catalog", () => {
    expect(classifyChange(p("Project", "Sources", "catalog.4DCatalog"), ROOT)).toBe("catalog");
  });

  it("classifies Resources/Constants_*.xlf as constants", () => {
    expect(classifyChange(p("Resources", "Constants_Project.xlf"), ROOT)).toBe("constants");
    expect(classifyChange(p("Resources", "Constants_en.xlf"), ROOT)).toBe("constants");
    expect(classifyChange(p("Resources", "Constants_4D.xlf"), ROOT)).toBe("constants");
  });

  it("classifies Components/**/*.4DZ as components", () => {
    expect(classifyChange(p("Components", "Foo.4dbase", "Foo.4DZ"), ROOT)).toBe("components");
    expect(classifyChange(p("Components", "Bar.4dbase", "Bar.4dz"), ROOT)).toBe("components");
    expect(classifyChange(p("Components", "Nested", "Deep", "thing.4DZ"), ROOT)).toBe("components");
  });

  it("returns unknown for unrecognized files", () => {
    expect(classifyChange(p("Project", "Sources", "README.md"), ROOT)).toBe("unknown");
    expect(classifyChange(p("Project", "Sources", "Catalog", "Tables", "Customers.json"), ROOT)).toBe("unknown");
    expect(classifyChange(p("Resources", "settings.json"), ROOT)).toBe("unknown");
    expect(classifyChange(p("Resources", "Other.xlf"), ROOT)).toBe("unknown");
    expect(classifyChange(p("Components", "Foo.4dbase", "manifest.json"), ROOT)).toBe("unknown");
    expect(classifyChange("/other-root/Project/Sources/Foo.4dm", ROOT)).toBe("unknown");
  });

  it("handles paths outside the project root as unknown", () => {
    expect(classifyChange("/tmp/random.4dm", ROOT)).toBe("unknown");
    expect(classifyChange("/usr/local/Constants_X.xlf", ROOT)).toBe("unknown");
  });
});
