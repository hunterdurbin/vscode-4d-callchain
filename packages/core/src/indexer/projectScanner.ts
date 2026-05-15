import * as fs from "fs";
import * as path from "path";

export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  category:
    | "method"
    | "compilerMethod"
    | "class"
    | "formMethod"
    | "formObjectMethod"
    | "tableFormMethod"
    | "tableObjectMethod"
    | "databaseMethod"
    | "formDefinition"        // Forms/<name>/form.4DForm JSON
    | "tableFormDefinition";  // TableForms/<id>/<name>/form.4DForm JSON
  containerName?: string;        // e.g. form name or class name
  ownerTableId?: string;
}

export interface ScanOptions {
  exclusions: string[];
}

export function discoverFiles(projectRoot: string, opts: ScanOptions): DiscoveredFile[] {
  const sourcesRoot = path.join(projectRoot, "Project", "Sources");
  if (!fs.existsSync(sourcesRoot)) {
    return [];
  }
  const out: DiscoveredFile[] = [];

  // Methods/
  walkDir(path.join(sourcesRoot, "Methods"), opts, (p) => {
    if (!p.endsWith(".4dm")) return;
    const base = path.basename(p, ".4dm");
    out.push({
      absolutePath: p,
      relativePath: path.relative(projectRoot, p),
      category: base.startsWith("Compiler_") ? "compilerMethod" : "method"
    });
  });

  // Classes/
  walkDir(path.join(sourcesRoot, "Classes"), opts, (p) => {
    if (!p.endsWith(".4dm")) return;
    out.push({
      absolutePath: p,
      relativePath: path.relative(projectRoot, p),
      category: "class",
      containerName: path.basename(p, ".4dm")
    });
  });

  // Forms/<name>/method.4dm + ObjectMethods/*.4dm
  const formsRoot = path.join(sourcesRoot, "Forms");
  if (fs.existsSync(formsRoot)) {
    for (const formName of safeReaddir(formsRoot)) {
      const formDir = path.join(formsRoot, formName);
      if (!isDir(formDir)) continue;
      const methodFile = path.join(formDir, "method.4dm");
      if (fs.existsSync(methodFile)) {
        out.push({
          absolutePath: methodFile,
          relativePath: path.relative(projectRoot, methodFile),
          category: "formMethod",
          containerName: formName
        });
      }
      const formDefFile = path.join(formDir, "form.4DForm");
      if (fs.existsSync(formDefFile)) {
        out.push({
          absolutePath: formDefFile,
          relativePath: path.relative(projectRoot, formDefFile),
          category: "formDefinition",
          containerName: formName
        });
      }
      const objMethods = path.join(formDir, "ObjectMethods");
      if (fs.existsSync(objMethods)) {
        walkDir(objMethods, opts, (p) => {
          if (!p.endsWith(".4dm")) return;
          out.push({
            absolutePath: p,
            relativePath: path.relative(projectRoot, p),
            category: "formObjectMethod",
            containerName: formName
          });
        });
      }
    }
  }

  // TableForms/<tableId>/<formName>/method.4dm + ObjectMethods/*.4dm
  const tableFormsRoot = path.join(sourcesRoot, "TableForms");
  if (fs.existsSync(tableFormsRoot)) {
    for (const tableId of safeReaddir(tableFormsRoot)) {
      const tableDir = path.join(tableFormsRoot, tableId);
      if (!isDir(tableDir)) continue;
      for (const formName of safeReaddir(tableDir)) {
        const formDir = path.join(tableDir, formName);
        if (!isDir(formDir)) continue;
        const methodFile = path.join(formDir, "method.4dm");
        if (fs.existsSync(methodFile)) {
          out.push({
            absolutePath: methodFile,
            relativePath: path.relative(projectRoot, methodFile),
            category: "tableFormMethod",
            containerName: formName,
            ownerTableId: tableId
          });
        }
        const formDefFile = path.join(formDir, "form.4DForm");
        if (fs.existsSync(formDefFile)) {
          out.push({
            absolutePath: formDefFile,
            relativePath: path.relative(projectRoot, formDefFile),
            category: "tableFormDefinition",
            containerName: formName,
            ownerTableId: tableId
          });
        }
        const objMethods = path.join(formDir, "ObjectMethods");
        if (fs.existsSync(objMethods)) {
          walkDir(objMethods, opts, (p) => {
            if (!p.endsWith(".4dm")) return;
            out.push({
              absolutePath: p,
              relativePath: path.relative(projectRoot, p),
              category: "tableObjectMethod",
              containerName: formName,
              ownerTableId: tableId
            });
          });
        }
      }
    }
  }

  // DatabaseMethods/
  walkDir(path.join(sourcesRoot, "DatabaseMethods"), opts, (p) => {
    if (!p.endsWith(".4dm")) return;
    out.push({
      absolutePath: p,
      relativePath: path.relative(projectRoot, p),
      category: "databaseMethod"
    });
  });

  return out;
}

/**
 * Read every table-name file from the 4D catalog. Each
 * `Project/Sources/Catalog/Tables/<TableName>.json` represents a dataclass.
 * The set is used by the resolver to validate `ds[_X]` bracket-access
 * references — `_Rules` is a constant whose value is `"Rules"`, and we
 * trust the convention that stripping the leading underscore yields the
 * actual table name iff that name is in the catalog.
 */
export function discoverCatalogTables(projectRoot: string): Set<string> {
  const out = new Set<string>();
  const tablesDir = path.join(projectRoot, "Project", "Sources", "Catalog", "Tables");
  if (!fs.existsSync(tablesDir)) return out;
  for (const entry of safeReaddir(tablesDir)) {
    if (entry.endsWith(".json")) out.add(entry.replace(/\.json$/, ""));
  }
  return out;
}

/**
 * Build a map from the numeric `@id` in each catalog Tables/*.json (used by 4D
 * as the TableForms/<id> directory name) to the friendly table name. Used to
 * resolve TableForm symbols' `ownerTable` to a human-readable label.
 */
export function discoverCatalogTableIdMap(projectRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  const tablesDir = path.join(projectRoot, "Project", "Sources", "Catalog", "Tables");
  if (!fs.existsSync(tablesDir)) return out;
  for (const entry of safeReaddir(tablesDir)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const json = JSON.parse(fs.readFileSync(path.join(tablesDir, entry), "utf8")) as { "@id"?: string; "@name"?: string };
      const id = json["@id"];
      const name = json["@name"] ?? entry.replace(/\.json$/, "");
      if (id) out.set(id, name);
    } catch {
      // skip malformed
    }
  }
  return out;
}

export interface DiscoveredPlugin {
  name: string;
  absolutePath: string;
  /** Command names exported by this plugin (parsed from manifest.json). */
  commands: string[];
}

export function discoverPlugins(projectRoot: string): DiscoveredPlugin[] {
  const pluginsRoot = path.join(projectRoot, "Plugins");
  if (!fs.existsSync(pluginsRoot)) return [];
  const out: DiscoveredPlugin[] = [];
  for (const entry of safeReaddir(pluginsRoot)) {
    if (!entry.endsWith(".bundle")) continue;
    const bundle = path.join(pluginsRoot, entry);
    out.push({
      name: entry.replace(/\.bundle$/, ""),
      absolutePath: bundle,
      commands: readPluginCommands(bundle)
    });
  }
  return out;
}

/**
 * Parse `<bundle>/Contents/Resources/manifest.json` for the plugin's exported
 * commands. Each manifest entry looks like
 *   { "theme": "IC TCP/IP", "syntax": "TCP_Open(&S;&I;&L;&I):I" }
 * The command name is everything before the first `(`.
 */
function readPluginCommands(bundlePath: string): string[] {
  const manifest = path.join(bundlePath, "Contents", "Resources", "manifest.json");
  if (!fs.existsSync(manifest)) return [];
  let doc: any;
  try {
    let raw = fs.readFileSync(manifest, "utf8");
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    doc = JSON.parse(raw);
  } catch { return []; }
  const entries: any[] = Array.isArray(doc?.commands) ? doc.commands : [];
  const out: string[] = [];
  for (const e of entries) {
    const syntax = typeof e?.syntax === "string" ? e.syntax : "";
    if (!syntax) continue;
    const paren = syntax.indexOf("(");
    const name = (paren > 0 ? syntax.slice(0, paren) : syntax).trim();
    if (name) out.push(name);
  }
  return out;
}

function walkDir(dir: string, opts: ScanOptions, visit: (path: string) => void): void {
  if (!fs.existsSync(dir)) return;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (opts.exclusions.includes(e.name)) continue;
        stack.push(p);
      } else if (e.isFile()) {
        visit(p);
      }
    }
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeReaddir(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}
