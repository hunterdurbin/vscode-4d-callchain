import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
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
 * Two sources contribute components:
 *
 *  1. **Project-local** — `${projectRoot}/Components/*.4dbase`. The user's
 *     own components that ship alongside the project.
 *  2. **4D-bundled** — `${4D.app}/Contents/Components/*.4dbase`. The
 *     components 4D itself bundles (NetKit, Widgets, ViewPro, WritePro, SVG,
 *     Progress, …). Discovered by probing installed 4D apps under
 *     `/Applications` (`4D.app`, `4D Server.app`, `tool4d.app`, plus a
 *     glob fallback for versioned bundles like `4D 20 R8/4D Server.app`).
 *
 * On name collision, project-local wins so the user can override bundled
 * components.
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
export function discoverComponents(
  projectRoot: string,
  opts?: { bundledComponentRoots?: string[] }
): DiscoveredComponent[] {
  const seen = new Set<string>();
  const out: DiscoveredComponent[] = [];

  const harvest = (componentsRoot: string) => {
    if (!fs.existsSync(componentsRoot)) return;
    for (const entry of safeReaddir(componentsRoot)) {
      if (!entry.endsWith(".4dbase")) continue;
      const name = entry.replace(/\.4dbase$/, "");
      // Project-local components are added first; bundled probes are second
      // and skipped on name collision so user overrides win.
      if (seen.has(name)) continue;
      seen.add(name);
      const bundlePath = path.join(componentsRoot, entry);
      const zipPath = findArchive(bundlePath);
      // One spawnSync per .4DZ instead of three — extract all three
      // metadata files in a single `unzip` call and parse the resulting
      // strings. Saves ~2/3 of the unzip startup cost per component
      // (a typical 4D install ships 10+ components, so ~20-40 fewer
      // spawns on cold load).
      const extracted = zipPath ? extractMetadataFromZip(zipPath) : EMPTY_EXTRACT;
      const methods = parseMethodNames(extracted.methodAttributes);
      const classStoreName = parseClassStoreName(extracted.settings) ?? name;
      const classes = parseClasses(extracted.classes);
      out.push({ name, bundlePath, zipPath, methods, classStoreName, classes });
    }
  };

  // 1. Project-local first.
  harvest(path.join(projectRoot, "Components"));

  // 2. 4D-bundled (probe installed apps unless caller injected explicit roots).
  const bundledRoots = opts?.bundledComponentRoots ?? findBundledComponentRoots();
  for (const root of bundledRoots) harvest(root);

  return out;
}

/**
 * Probe `/Applications` for installed 4D apps and return their
 * `Contents/Components` directories. Mirrors the probe strategy in
 * `constantsScanner.findBuiltinConstantsFile`: try the canonical bundle
 * names first, then scan `/Applications/*` (one level deep) for any
 * `*.app` whose name looks 4D-flavored. Returns existing directories
 * only; absence is silent (running on a machine without 4D installed is
 * the test environment).
 */
export function findBundledComponentRoots(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => {
    if (seen.has(p)) return;
    seen.add(p);
    if (fs.existsSync(p)) out.push(p);
  };

  // Canonical, version-less install names.
  push("/Applications/4D.app/Contents/Components");
  push("/Applications/4D Server.app/Contents/Components");
  push("/Applications/tool4d.app/Contents/Components");

  // Versioned installs: `/Applications/4D 20 R8/4D Server.app`, etc.
  // Walk one level into `/Applications/*` for `*.app` bundles.
  const appsRoot = "/Applications";
  if (fs.existsSync(appsRoot)) {
    for (const entry of safeReaddir(appsRoot)) {
      const entryPath = path.join(appsRoot, entry);
      let stat: fs.Stats;
      try { stat = fs.statSync(entryPath); } catch { continue; }
      if (stat.isDirectory() && entry.endsWith(".app")) {
        // Direct .app at /Applications/<name>.app
        if (/(4D|tool4d)/i.test(entry)) {
          push(path.join(entryPath, "Contents/Components"));
        }
      } else if (stat.isDirectory() && /(4D|tool4d)/i.test(entry)) {
        // Versioned wrapper like /Applications/4D 20 R8/ — scan inside.
        for (const sub of safeReaddir(entryPath)) {
          if (!sub.endsWith(".app")) continue;
          push(path.join(entryPath, sub, "Contents/Components"));
        }
      }
    }
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
 * Three metadata files the component scanner reads from each `.4DZ`.
 * Shells out to `unzip` once per component (instead of three times) to
 * extract them all into a temp directory, then parses the resulting
 * strings in pure JS. Files absent from the archive come back as
 * `undefined`; downstream parsers tolerate that.
 */
interface ExtractedMetadata {
  methodAttributes: string | undefined;
  settings: string | undefined;
  classes: string | undefined;
}
const EMPTY_EXTRACT: ExtractedMetadata = {
  methodAttributes: undefined,
  settings: undefined,
  classes: undefined,
};

const ZIP_PATH_METHOD_ATTRS = "Project/DerivedData/methodAttributes.json";
const ZIP_PATH_SETTINGS = "Project/Sources/settings.4DSettings";
const ZIP_PATH_CLASSES = "Project/DerivedData/CompiledCode/classes.json";

function extractMetadataFromZip(zipPath: string): ExtractedMetadata {
  // `unzip -d <tmpdir> <archive> <files...>` runs a single subprocess
  // that extracts all named entries at once. unzip silently skips
  // entries that don't exist in the archive, so we don't need to
  // pre-check membership. `unzip` is almost always present on
  // macOS/Linux; on Windows 10+ the same syntax works via the
  // bundled shim.
  let tmpDir: string | undefined;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fourd-comp-"));
  } catch {
    return EMPTY_EXTRACT;
  }
  try {
    const result = cp.spawnSync(
      "unzip",
      ["-qq", "-o", zipPath, ZIP_PATH_METHOD_ATTRS, ZIP_PATH_SETTINGS, ZIP_PATH_CLASSES, "-d", tmpDir],
      { encoding: "utf8" },
    );
    if (result.error) return EMPTY_EXTRACT;
    // unzip returns 11 when nothing matched (e.g. component ships none
    // of these). That's not an error from our perspective.
    if (result.status !== 0 && result.status !== 11) return EMPTY_EXTRACT;
    return {
      methodAttributes: readIfPresent(path.join(tmpDir, ZIP_PATH_METHOD_ATTRS)),
      settings: readIfPresent(path.join(tmpDir, ZIP_PATH_SETTINGS)),
      classes: readIfPresent(path.join(tmpDir, ZIP_PATH_CLASSES)),
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {/* ignore */}
  }
}

function readIfPresent(p: string): string | undefined {
  try {
    let raw = fs.readFileSync(p, "utf8");
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return raw;
  } catch {
    return undefined;
  }
}

function parseMethodNames(raw: string | undefined): string[] {
  if (!raw) return [];
  let doc: any;
  try { doc = JSON.parse(raw); } catch { return []; }
  const methods = doc?.methods;
  if (!methods || typeof methods !== "object") return [];
  return Object.keys(methods);
}

function parseClassStoreName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = raw.match(/component_classStore_name\s*=\s*"([^"]+)"/);
  return m ? m[1] : undefined;
}

/**
 * Parse `CompiledCode/classes.json` to discover classes + their functions.
 * The shape is `{ "ClassName": { functions: { "fnName": <numeric-id>, ... },
 * properties?: {...}, constructorID?: <numeric-id> } }`.
 */
function parseClasses(raw: string | undefined): DiscoveredComponentClass[] {
  if (!raw) return [];
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
