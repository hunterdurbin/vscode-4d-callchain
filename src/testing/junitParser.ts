import * as fs from "fs";
import { XMLParser } from "fast-xml-parser";

export interface TestResult {
  className: string;
  testName: string;
  status: "passed" | "failed" | "errored" | "skipped";
  durationMs?: number;
  message?: string;
  file?: string;
}

export interface JUnitParseResult {
  results: TestResult[];
  totals: { tests: number; failures: number; errors: number; skipped: number; durationMs: number };
  generatedAt?: string;
}

export function parseJUnitFile(filePath: string): JUnitParseResult | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  let xml: string;
  try {
    xml = fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  return parseJUnitString(xml);
}

export function parseJUnitString(xml: string): JUnitParseResult {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    allowBooleanAttributes: true,
    parseAttributeValue: true,
    isArray: (name) => ["testsuite", "testcase", "failure", "error", "skipped"].includes(name)
  });
  const doc = parser.parse(xml) as any;
  const suites: any[] = doc?.testsuites?.testsuite ?? doc?.testsuite ?? [];
  const results: TestResult[] = [];
  let tests = 0, failures = 0, errors = 0, skipped = 0, durationMs = 0;
  for (const suite of suites) {
    const className = suite["@name"];
    const cases: any[] = suite.testcase ?? [];
    for (const tc of cases) {
      const t = Number(tc["@time"] ?? 0);
      durationMs += t * 1000;
      const result: TestResult = {
        className: String(tc["@classname"] ?? className ?? ""),
        testName: String(tc["@name"]),
        durationMs: t * 1000,
        file: tc["@file"] ? String(tc["@file"]) : undefined,
        status: "passed"
      };
      const failureNode = tc.failure?.[0] ?? tc.failure;
      const errorNode = tc.error?.[0] ?? tc.error;
      const skippedNode = tc.skipped?.[0] ?? tc.skipped;
      if (failureNode) {
        result.status = "failed";
        result.message = extractMessage(failureNode);
        failures++;
      } else if (errorNode) {
        result.status = "errored";
        result.message = extractMessage(errorNode);
        errors++;
      } else if (skippedNode) {
        result.status = "skipped";
        skipped++;
      }
      tests++;
      results.push(result);
    }
  }
  return {
    results,
    totals: { tests, failures, errors, skipped, durationMs },
    generatedAt: doc?.testsuites?.["@timestamp"]
  };
}

function extractMessage(node: any): string | undefined {
  if (typeof node === "string") return node;
  if (node["@message"]) return String(node["@message"]);
  if (node["#text"]) return String(node["#text"]);
  return undefined;
}

export function indexByClass(results: TestResult[]): Map<string, Map<string, TestResult>> {
  const out = new Map<string, Map<string, TestResult>>();
  for (const r of results) {
    let bucket = out.get(r.className);
    if (!bucket) {
      bucket = new Map();
      out.set(r.className, bucket);
    }
    bucket.set(r.testName, r);
  }
  return out;
}
