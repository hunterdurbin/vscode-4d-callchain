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
  rawValue?: string;
  theme?: string;
  sourceFile: string;
}

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
    // Walk every trans-unit anywhere in the tree.
    walkTransUnits(doc, undefined, (unit, theme) => {
      const id = unit["@id"];
      if (typeof id !== "string" || !id.startsWith("k_")) return;
      const rawSource = unit.source;
      const name = typeof rawSource === "string" ? rawSource.trim() : (rawSource?.["#text"] ?? "").toString().trim();
      if (!name) return;
      const rawValue: string | undefined = unit["@d4:value"];
      const value = parseValueAttr(rawValue);
      out.push({ name, value: value.value, rawValue, theme, sourceFile: file });
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

function walkTransUnits(node: any, theme: string | undefined, visit: (unit: any, theme?: string) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkTransUnits(child, theme, visit);
    return;
  }
  // Capture theme name from `<group resname="themes"><trans-unit resname="UUID"><source>` patterns —
  // 4D's theme metadata isn't strictly attached to constants in the XLF, so we leave theme undefined
  // unless a parent <group> carries an obvious name.
  let nextTheme = theme;
  const groupName = node["@resname"];
  if (typeof groupName === "string" && groupName.length > 0 && groupName !== "themes") {
    nextTheme = groupName;
  }
  if (Array.isArray(node["trans-unit"])) {
    for (const u of node["trans-unit"]) visit(u, nextTheme);
  }
  for (const key of Object.keys(node)) {
    if (key === "trans-unit" || key.startsWith("@") || key === "#text") continue;
    walkTransUnits(node[key], nextTheme, visit);
  }
}

function safeReaddir(p: string): string[] {
  try { return fs.readdirSync(p); } catch { return []; }
}
