import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";

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
}

/**
 * Walk `Components/*.4dbase` and read each component's exposed method names.
 *
 * Components are typically shipped compiled as a `.4DZ` (zip archive). The
 * source `.4dm` files are absent, but `Project/DerivedData/methodAttributes.json`
 * inside the archive lists every project method by name. We extract that file
 * via `unzip -p` and parse it — the keys of the `methods` object are the
 * method names exposed to the host project.
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
    out.push({ name, bundlePath, zipPath, methods });
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

function safeReaddir(p: string): string[] {
  try { return fs.readdirSync(p); } catch { return []; }
}
