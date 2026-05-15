import * as fs from "fs";
import * as path from "path";
import { XMLParser } from "fast-xml-parser";

/**
 * A constant declared in `Resources/Constants_*.xlf`. The XLIFF format used by
 * 4D project mode stores each named constant as:
 *
 *   <trans-unit d4:value="value:type" id="k_NNNN">
 *     <source>_ConstantName</source>
 *   </trans-unit>
 *
 * Theme-group entries use `thm_N` ids and have no `d4:value` — we skip them.
 */
export interface DiscoveredConstant {
  name: string;
  value?: string;
  /** Friendly type name like "Text" / "Longint" / "Boolean". */
  type?: string;
  rawValue?: string;
  theme?: string;
  sourceFile: string;
}

/**
 * 4D XLIFF stores constant types as a one-letter suffix on the d4:value
 * attribute (e.g. `"Rules:S"`). Map the letters to human-readable names.
 * Letters covered match 4D v21 conventions; unknowns pass through verbatim.
 */
const TYPE_LETTER_NAMES: Record<string, string> = {
  S: "Text",
  L: "Longint",
  R: "Real",
  N: "Number",
  B: "Boolean",
  D: "Date",
  H: "Time",
  T: "Time",
  P: "Picture",
  X: "Pointer",
  C: "Collection",
  O: "Object",
  A: "Alpha",
  Y: "BLOB"
};

export function discoverConstants(projectRoot: string): DiscoveredConstant[] {
  const resourcesDir = path.join(projectRoot, "Resources");
  if (!fs.existsSync(resourcesDir)) return [];
  const xlfFiles: string[] = [];
  for (const entry of safeReaddir(resourcesDir)) {
    if (entry.startsWith("Constants_") && entry.endsWith(".xlf")) {
      xlfFiles.push(path.join(resourcesDir, entry));
    }
  }
  const out: DiscoveredConstant[] = [];
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    isArray: (name) => ["trans-unit", "group"].includes(name),
    parseAttributeValue: false
  });
  for (const file of xlfFiles) {
    let xml: string;
    try { xml = fs.readFileSync(file, "utf8"); } catch { continue; }
    let doc: any;
    try { doc = parser.parse(xml); } catch { continue; }

    // Pass 1: build UUID → theme-name map from the themes group.
    //   <group resname="themes">
    //     <trans-unit id="thm_N" resname="UUID"><source>Theme Name</source></trans-unit>
    //   </group>
    const themeByUuid = new Map<string, string>();
    walkThemeUnits(doc, (unit) => {
      const id = unit["@id"];
      if (typeof id !== "string" || !id.startsWith("thm_")) return;
      const uuid = unit["@resname"];
      const rawSource = unit.source;
      const name = typeof rawSource === "string" ? rawSource.trim() : (rawSource?.["#text"] ?? "").toString().trim();
      if (typeof uuid === "string" && uuid && name) themeByUuid.set(uuid, name);
    });

    // Pass 2: walk constant groups, resolve theme via parent group's d4:groupName.
    walkConstantGroups(doc, undefined, (unit, groupUuid) => {
      const id = unit["@id"];
      if (typeof id !== "string" || !id.startsWith("k_")) return;
      const rawSource = unit.source;
      const name = typeof rawSource === "string" ? rawSource.trim() : (rawSource?.["#text"] ?? "").toString().trim();
      if (!name) return;
      const rawValue: string | undefined = unit["@d4:value"];
      const parsed = parseValueAttr(rawValue);
      out.push({
        name,
        value: parsed.value,
        type: parsed.type ? (TYPE_LETTER_NAMES[parsed.type] ?? parsed.type) : undefined,
        rawValue,
        theme: groupUuid ? themeByUuid.get(groupUuid) : undefined,
        sourceFile: file
      });
    });
  }
  return out;
}

/** `"Rules:S"` → "Rules" (string); `"3:L"` → "3" (longint). Returns undefined if value is empty. */
function parseValueAttr(raw: string | undefined): { value?: string; type?: string } {
  if (!raw) return {};
  const m = raw.match(/^(.*):([A-Z])$/);
  if (m) return { value: m[1], type: m[2] };
  return { value: raw };
}

/**
 * Visit every trans-unit inside the `<group resname="themes">` block — that's
 * where 4D records its UUID → display-name mapping for themes.
 */
function walkThemeUnits(node: any, visit: (unit: any) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const c of node) walkThemeUnits(c, visit); return; }
  if (node["@resname"] === "themes" && Array.isArray(node["trans-unit"])) {
    for (const u of node["trans-unit"]) visit(u);
    return; // themes group has no nested groups we care about
  }
  for (const key of Object.keys(node)) {
    if (key === "trans-unit" || key.startsWith("@") || key === "#text") continue;
    walkThemeUnits(node[key], visit);
  }
}

/**
 * Visit every constant trans-unit, tracking the enclosing group's
 * d4:groupName UUID so the caller can look up the friendly theme name.
 */
function walkConstantGroups(node: any, groupUuid: string | undefined, visit: (unit: any, groupUuid?: string) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const c of node) walkConstantGroups(c, groupUuid, visit); return; }
  // Skip the themes block — those trans-units aren't constants.
  if (node["@resname"] === "themes") return;
  const nextUuid = (typeof node["@d4:groupName"] === "string" && node["@d4:groupName"]) || groupUuid;
  if (Array.isArray(node["trans-unit"])) {
    for (const u of node["trans-unit"]) visit(u, nextUuid);
  }
  for (const key of Object.keys(node)) {
    if (key === "trans-unit" || key.startsWith("@") || key === "#text") continue;
    walkConstantGroups(node[key], nextUuid, visit);
  }
}

function safeReaddir(p: string): string[] {
  try { return fs.readdirSync(p); } catch { return []; }
}

export interface BuiltinConstant {
  name: string;
  value?: string;
  /** Theme name e.g. "Form events" — resolved from 4D_ConstantsThemesEN.xlf when available. */
  theme?: string;
  sourceFile: string;
}

/**
 * Default locations to probe for the 4D built-in constants XLF. Order matters:
 * we want the most-likely user installation first so we don't pick a stale copy.
 */
export const DEFAULT_BUILTIN_CONSTANTS_PROBES = [
  "/Applications/tool4d.app/Contents/Resources/en.lproj/4D_ConstantsEN.xlf",
  "/Applications/4D.app/Contents/Resources/en.lproj/4D_ConstantsEN.xlf",
  "/Applications/4D Server.app/Contents/Resources/en.lproj/4D_ConstantsEN.xlf"
];

/**
 * Locate the built-in constants file. Returns the first existing path from
 * the supplied search list, or scans /Applications/* for any 4D-flavoured
 * `.app` that ships the file (useful when multiple 4D versions are installed).
 */
export function findBuiltinConstantsFile(searchPaths: string[]): string | undefined {
  for (const p of searchPaths) {
    if (p && fs.existsSync(p)) return p;
  }
  // Scan /Applications for any *.app containing the file.
  const appsRoot = "/Applications";
  if (!fs.existsSync(appsRoot)) return undefined;
  for (const entry of safeReaddir(appsRoot)) {
    if (!entry.endsWith(".app")) continue;
    if (!/(tool4d|4D)/i.test(entry)) continue;
    const candidate = path.join(appsRoot, entry, "Contents/Resources/en.lproj/4D_ConstantsEN.xlf");
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Parse 4D's built-in constants XLF. The format differs slightly from the user
 * Constants_*.xlf:
 *   <group d4:groupID="N" d4:groupName="ConstTheme_N">
 *     <trans-unit id="N_M" d4:value="V">
 *       <source>Constant Name</source>
 *       ...
 *     </trans-unit>
 *   </group>
 * `d4:value` is the bare value (no `:S`/`:L` type suffix). Theme labels live
 * in a sibling file `4D_ConstantsThemesEN.xlf` keyed by ConstTheme_N — we load
 * that side-file when available to attach friendly theme names.
 */
export function discoverBuiltinConstants(searchPaths: string[]): BuiltinConstant[] {
  const xlf = findBuiltinConstantsFile(searchPaths);
  if (!xlf) return [];
  let xml: string;
  try { xml = fs.readFileSync(xlf, "utf8"); } catch { return []; }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    isArray: (name) => ["trans-unit", "group"].includes(name),
    parseAttributeValue: false
  });
  let doc: any;
  try { doc = parser.parse(xml); } catch { return []; }

  // Side-file with theme labels (best-effort).
  const themeMap = new Map<string, string>();
  const themesPath = path.join(path.dirname(xlf), "4D_ConstantsThemesEN.xlf");
  if (fs.existsSync(themesPath)) {
    try {
      const themesXml = fs.readFileSync(themesPath, "utf8");
      const themesDoc = parser.parse(themesXml);
      walkAnyTransUnits(themesDoc, (unit) => {
        const resname = unit["@resname"];
        const source = typeof unit.source === "string" ? unit.source : unit.source?.["#text"];
        if (typeof resname === "string" && resname.startsWith("ConstTheme_") && source) {
          themeMap.set(resname, String(source).trim());
        }
      });
    } catch { /* ignore */ }
  }

  const out: BuiltinConstant[] = [];
  walkBuiltinGroups(doc, (groupName, unit) => {
    const source = typeof unit.source === "string" ? unit.source : unit.source?.["#text"];
    if (!source) return;
    const name = String(source).trim();
    if (!name) return;
    const raw: string | undefined = unit["@d4:value"];
    out.push({
      name,
      value: raw ?? undefined,
      theme: groupName ? themeMap.get(groupName) ?? groupName : undefined,
      sourceFile: xlf
    });
  });
  return out;
}

function walkBuiltinGroups(node: any, visit: (groupName: string | undefined, unit: any) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const c of node) walkBuiltinGroups(c, visit); return; }
  const groupName: string | undefined = node["@d4:groupName"];
  if (Array.isArray(node["trans-unit"])) {
    for (const u of node["trans-unit"]) visit(groupName, u);
  }
  for (const key of Object.keys(node)) {
    if (key === "trans-unit" || key.startsWith("@") || key === "#text") continue;
    walkBuiltinGroups(node[key], visit);
  }
}

function walkAnyTransUnits(node: any, visit: (unit: any) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const c of node) walkAnyTransUnits(c, visit); return; }
  if (Array.isArray(node["trans-unit"])) {
    for (const u of node["trans-unit"]) visit(u);
  }
  for (const key of Object.keys(node)) {
    if (key === "trans-unit" || key.startsWith("@") || key === "#text") continue;
    walkAnyTransUnits(node[key], visit);
  }
}
