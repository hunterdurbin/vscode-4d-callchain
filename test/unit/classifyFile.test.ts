import { describe, expect, it } from "vitest";
import * as path from "path";
import { classifyFile } from "../../packages/core/dist/indexer/projectScanner";

const ROOT = "/proj";

function p(...parts: string[]): string {
  return path.join(ROOT, ...parts);
}

describe("classifyFile", () => {
  it("classifies Methods/*.4dm as method", () => {
    const f = classifyFile(p("Project", "Sources", "Methods", "Foo.4dm"), ROOT);
    expect(f).toMatchObject({ category: "method" });
  });

  it("classifies Methods/Compiler_*.4dm as compilerMethod", () => {
    const f = classifyFile(p("Project", "Sources", "Methods", "Compiler_All.4dm"), ROOT);
    expect(f).toMatchObject({ category: "compilerMethod" });
  });

  it("classifies Classes/<X>.4dm as class with containerName", () => {
    const f = classifyFile(p("Project", "Sources", "Classes", "Customer.4dm"), ROOT);
    expect(f).toMatchObject({ category: "class", containerName: "Customer" });
  });

  it("classifies DatabaseMethods/*.4dm as databaseMethod", () => {
    const f = classifyFile(p("Project", "Sources", "DatabaseMethods", "onStartup.4dm"), ROOT);
    expect(f).toMatchObject({ category: "databaseMethod" });
  });

  it("classifies Forms/<name>/method.4dm as formMethod", () => {
    const f = classifyFile(p("Project", "Sources", "Forms", "Login", "method.4dm"), ROOT);
    expect(f).toMatchObject({ category: "formMethod", containerName: "Login" });
  });

  it("classifies Forms/<name>/form.4DForm as formDefinition", () => {
    const f = classifyFile(p("Project", "Sources", "Forms", "Login", "form.4DForm"), ROOT);
    expect(f).toMatchObject({ category: "formDefinition", containerName: "Login" });
  });

  it("classifies Forms/<name>/ObjectMethods/*.4dm as formObjectMethod", () => {
    const f = classifyFile(p("Project", "Sources", "Forms", "Login", "ObjectMethods", "btn.4dm"), ROOT);
    expect(f).toMatchObject({ category: "formObjectMethod", containerName: "Login" });
  });

  it("classifies TableForms/<id>/<name>/method.4dm as tableFormMethod", () => {
    const f = classifyFile(p("Project", "Sources", "TableForms", "25", "input", "method.4dm"), ROOT);
    expect(f).toMatchObject({
      category: "tableFormMethod",
      containerName: "input",
      ownerTableId: "25"
    });
  });

  it("classifies TableForms/<id>/<name>/ObjectMethods/*.4dm", () => {
    const f = classifyFile(
      p("Project", "Sources", "TableForms", "25", "input", "ObjectMethods", "btn.4dm"),
      ROOT
    );
    expect(f).toMatchObject({
      category: "tableObjectMethod",
      containerName: "input",
      ownerTableId: "25"
    });
  });

  it("returns undefined for non-source paths", () => {
    expect(classifyFile(p("Project", "Sources", "Catalog", "Tables", "Customer.json"), ROOT)).toBeUndefined();
    expect(classifyFile(p("Resources", "Constants_en.xlf"), ROOT)).toBeUndefined();
    expect(classifyFile(p("Project", "Sources", "Methods", "README.md"), ROOT)).toBeUndefined();
    expect(classifyFile("/other-root/Foo.4dm", ROOT)).toBeUndefined();
  });
});
