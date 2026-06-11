import * as fs from "fs";
import { TestResult } from "./results";

/**
 * Parses the JSON test-results format produced by the 4D testing component
 * (`make test format=json outputPath=…`). Same format consumed by
 * ScottHarris.4d-testing-extension. Strictly richer than the JUnit XML output —
 * includes assertion-level results, runtime errors, and call chains.
 */

export interface JsonAssertion {
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
  message?: string;
  line?: number;
  functionName?: string;
  isRuntimeError?: boolean;
}

export interface JsonRuntimeError {
  code?: number;
  processNumber?: number;
  text?: string;
  method?: string;
  message?: string;
  line?: number;
  callChainJSON?: string;
}

export interface JsonCallFrame {
  name?: string;
  line?: number;
  type?: string;
}

export interface JsonTestResult {
  suite: string;
  name: string;
  passed: boolean;
  skipped?: boolean;
  duration?: number;
  assertionCount?: number;
  assertions?: JsonAssertion[];
  runtimeErrors?: JsonRuntimeError[];
  callChain?: JsonCallFrame[];
}

export interface JsonResultsFile {
  testResults: JsonTestResult[];
  hasGlobalErrors?: boolean;
  globalErrors?: JsonRuntimeError[];
}

export interface JsonParseResult {
  results: TestResult[];      // converted to our shared shape
  raw: JsonResultsFile;
  totals: { tests: number; failures: number; errors: number; skipped: number; durationMs: number };
}

/**
 * 4D occasionally emits literal control characters inside JSON string values.
 * This mirrors ScottHarris's sanitizer so we tolerate the same edge case.
 */
function escapeControlCharsInJsonStrings(s: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) { out += c; escaped = false; continue; }
    if (c === "\\") { out += c; escaped = true; continue; }
    if (c === '"') { inString = !inString; out += c; continue; }
    if (inString) {
      const code = c.charCodeAt(0);
      if (code === 0x0A) out += "\\n";
      else if (code === 0x0D) out += "\\r";
      else if (code === 0x09) out += "\\t";
      else if (code === 0x08) out += "\\b";
      else if (code === 0x0C) out += "\\f";
      else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
      else out += c;
    } else {
      out += c;
    }
  }
  return out;
}

export function parseJsonResultsFile(filePath: string): JsonParseResult | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return parseJsonResultsString(text);
}

export function parseJsonResultsString(text: string): JsonParseResult | undefined {
  let raw: JsonResultsFile;
  try {
    raw = JSON.parse(text);
  } catch {
    try {
      raw = JSON.parse(escapeControlCharsInJsonStrings(text));
    } catch {
      return undefined;
    }
  }
  if (!raw?.testResults || !Array.isArray(raw.testResults)) return undefined;

  const results: TestResult[] = [];
  let failures = 0, errors = 0, skipped = 0, durationMs = 0;
  for (const r of raw.testResults) {
    const isError = (r.runtimeErrors && r.runtimeErrors.length > 0);
    const dur = typeof r.duration === "number" ? r.duration : 0;
    durationMs += dur;
    let status: TestResult["status"];
    if (r.skipped) { status = "skipped"; skipped++; }
    else if (isError) { status = "errored"; errors++; }
    else if (r.passed) { status = "passed"; }
    else { status = "failed"; failures++; }

    let message: string | undefined;
    if (status === "failed" && r.assertions) {
      const firstFail = r.assertions.find((a) => !a.passed && !a.isRuntimeError);
      if (firstFail) {
        const parts: string[] = [];
        if (firstFail.message) parts.push(firstFail.message);
        parts.push(`expected ${JSON.stringify(firstFail.expected)} · actual ${JSON.stringify(firstFail.actual)}`);
        message = parts.join("\n");
      }
    } else if (status === "errored" && r.runtimeErrors?.[0]) {
      const err = r.runtimeErrors[0];
      const head = err.code != null ? `[${err.code}] ` : "";
      message = `${head}${err.message ?? err.method ?? "Runtime error"}${err.text ? `\n  ${err.text}` : ""}${err.line != null ? ` (line ${err.line})` : ""}`;
    }

    results.push({
      className: r.suite,
      testName: r.name,
      status,
      durationMs: dur,
      message
    });
  }
  return {
    raw,
    results,
    totals: { tests: results.length, failures, errors, skipped, durationMs }
  };
}
