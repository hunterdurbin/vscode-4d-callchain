/** A single test outcome, the shared shape every results source converts to. */
export interface TestResult {
  className: string;
  testName: string;
  status: "passed" | "failed" | "errored" | "skipped";
  durationMs?: number;
  message?: string;
  file?: string;
}

/** Index results by class then test name, the lookup the gutter decorator uses. */
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
