import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface DiscoveredComponentClassProp {
  /** The class type this property holds, as it appears in classes.json. */
  className: string;
  /** Optional component the type comes from — empty means "current component". */
  componentName: string;
}

export interface DiscoveredComponentClass {
  /** Class name as it appears in classes.json (e.g. "Testing", "Assert"). */
  name: string;
  /** Function names defined on the class. */
  functions: string[];
  /** True if classes.json records a `constructorID` for this class. */
  hasConstructor: boolean;
  /** Property name -> declared class type (for chain resolution: $x.prop.method()). */
  properties: Record<string, DiscoveredComponentClassProp>;
}

export interface DiscoveredComponent {
  /** Display name — basename without `.4dbase`. */
  name: string;
  /** Absolute path to the `.4dbase` folder. */
  bundlePath: string;
  /** Absolute path to the `.4DZ` archive inside the bundle, if present. */
  zipPath?: string;
  /** Method names exposed by the component, read from the .4DZ's
   *  methodAttributes.json. */
  methods: string[];
  /** The `cs.<name>` namespace this component exposes, from
   *  settings.4DSettings' `component_classStore_name` attribute.
   *  Falls back to the component directory name when absent. */
  classStoreName: string;
  /** Classes exposed under the classStore namespace, parsed from
   *  CompiledCode/classes.json. Empty when the archive lacks that file. */
  classes: DiscoveredComponentClass[];
}

/**
 * Walk `Components/*.4dbase` and read each component's exposed method names.
 *
 * Components are typically shipped compiled as a `.4DZ` (zip archive). The
 * source `.4dm` files are absent, but `Project/DerivedData/methodAttributes.json`
 * inside the archive lists every project method by name. We extract that file
 * via `unzip -p` and parse it — the keys of the `methods` object are the
 * method names exposed to the host project.
 *
 * **Why component-class symbols are line-only (see TODO #12):** as of 4D v21,
 * the `.4DZ` format ships only metadata + compiled bytecode (`MX64`/`IX64`
 * files) — no `.4dm` source. The class metadata in
 * `Project/DerivedData/CompiledCode/classes.json` records function names and
 * numeric IDs but no source positions, so every Component / ComponentMethod
 * / ClassFunction symbol the resolver builds from a component has
 * `location.column === undefined`. Downstream features that require
 * columns (semantic tokens, precise rename ranges) detect that case via
 * the `ownerComponent` marker on the symbol and skip / degrade gracefully.
 * If a future 4D release starts embedding sources, this scanner is the
 * place to thread them into `parseFile()` for real positions.
 */
export function discoverComponents(projectRoot: string): DiscoveredComponent[] {
  const componentsRoot = path.join(projectRoot, "Components");
  if (!fs.existsSync(componentsRoot)) return [];
  const out: DiscoveredComponent[] = [];
  for (const entry of safeReaddir(componentsRoot)) {
    if (!entry.endsWith(".4dbase")) continue;
    const bundlePath = path.join(componentsRoot, entry);
    const name = entry.replace(/\.4dbase$/, "");
    const zipPath = findArchive(bundlePath);
    const methods = zipPath ? readMethodNamesFromZip(zipPath) : [];
    const classStoreName = (zipPath && readClassStoreName(zipPath)) || name;
    const classes = zipPath ? readClassesFromZip(zipPath) : [];
    out.push({ name, bundlePath, zipPath, methods, classStoreName, classes });
  }
  return out;
}

function findArchive(bundlePath: string): string | undefined {
  for (const entry of safeReaddir(bundlePath)) {
    if (entry.endsWith(".4DZ") || entry.endsWith(".4dz")) {
      return path.join(bundlePath, entry);
    }
  }
  return undefined;
}

/**
 * Extract `methodAttributes.json` from the `.4DZ` and pull the method-name
 * keys. Shells out to `unzip -p` — almost always available on macOS/Linux
 * and on Windows 10+ via the `bsdtar`/`unzip` shims. Returns [] on any
 * failure (missing tool, malformed JSON, etc.).
 */
function readMethodNamesFromZip(zipPath: string): string[] {
  const result = cp.spawnSync("unzip", ["-p", zipPath, "Project/DerivedData/methodAttributes.json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0 || !result.stdout) return [];
  let raw = result.stdout;
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  let doc: any;
  try { doc = JSON.parse(raw); } catch { return []; }
  const methods = doc?.methods;
  if (!methods || typeof methods !== "object") return [];
  return Object.keys(methods);
}

/**
 * Pull `component_classStore_name` from the .4DZ's settings.4DSettings.
 * Returns undefined when the attribute is missing — callers should fall
 * back to the component directory name.
 */
function readClassStoreName(zipPath: string): string | undefined {
  const result = cp.spawnSync("unzip", ["-p", zipPath, "Project/Sources/settings.4DSettings"], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.status !== 0 || !result.stdout) return undefined;
  const m = result.stdout.match(/component_classStore_name\s*=\s*"([^"]+)"/);
  return m ? m[1] : undefined;
}

/**
 * Parse `CompiledCode/classes.json` to discover classes + their functions.
 * The shape is `{ "ClassName": { functions: { "fnName": <numeric-id>, ... },
 * properties?: {...}, constructorID?: <numeric-id> } }`.
 */
function readClassesFromZip(zipPath: string): DiscoveredComponentClass[] {
  const result = cp.spawnSync("unzip", ["-p", zipPath, "Project/DerivedData/CompiledCode/classes.json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.status !== 0 || !result.stdout) return [];
  let raw = result.stdout;
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  let doc: any;
  try { doc = JSON.parse(raw); } catch { return []; }
  if (!doc || typeof doc !== "object") return [];
  const out: DiscoveredComponentClass[] = [];
  for (const className of Object.keys(doc)) {
    const entry = doc[className];
    if (!entry || typeof entry !== "object") continue;
    const fnObj = entry.functions;
    const functions = fnObj && typeof fnObj === "object" ? Object.keys(fnObj) : [];
    const hasConstructor = typeof entry.constructorID === "number";
    const properties: Record<string, DiscoveredComponentClassProp> = {};
    const propsObj = entry.properties;
    if (propsObj && typeof propsObj === "object") {
      for (const propName of Object.keys(propsObj)) {
        const p = propsObj[propName];
        if (!p || typeof p !== "object") continue;
        const propCls = typeof p.className === "string" ? p.className : "";
        const propComp = typeof p.componentName === "string" ? p.componentName : "";
        // Skip untyped properties and 4D built-in placeholder types.
        if (!propCls || isBuiltinTypePlaceholder(propCls)) continue;
        properties[propName] = { className: propCls, componentName: propComp };
      }
    }
    out.push({ name: className, functions, hasConstructor, properties });
  }
  return out;
}

/**
 * Some `properties` entries in classes.json use 4D's internal type names
 * (`Class`, `Object`, `Function`, `Collection`, etc.) rather than a real
 * user/component class. These can't be resolved further so we drop them.
 */
function isBuiltinTypePlaceholder(name: string): boolean {
  switch (name) {
    case "Class":
    case "Object":
    case "Function":
    case "Collection":
    case "Date":
    case "Time":
    case "Blob":
    case "Picture":
      return true;
    default:
      return false;
  }
}

function safeReaddir(p: string): string[] {
  try { return fs.readdirSync(p); } catch { return []; }
}
