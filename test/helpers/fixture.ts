import * as fs from "node:fs";
import * as path from "node:path";
import { describe } from "vitest";

// Default to the committed mini-fixture under test/fixtures/mini-4d/. Set
// FOURD_TEST_PROJECT=/path/to/4d-project to run against a larger real project
// for volume-style coverage; the curated mini-fixture is the source of truth
// for deterministic regression assertions.
const DEFAULT_FIXTURE = path.resolve(__dirname, "../fixtures/mini-4d");

export function resolveFixture(): string | null {
  const candidate = process.env.FOURD_TEST_PROJECT ?? DEFAULT_FIXTURE;
  if (!candidate) return null;
  return fs.existsSync(path.join(candidate, "Project")) ? candidate : null;
}

// Probe list for 4D's built-in constants. For the committed mini fixture, a
// hermetic stand-in XLF is probed FIRST so builtin-constant assertions behave
// identically with or without a local 4D installation. A real project (via
// FOURD_TEST_PROJECT) keeps the default /Applications/4D*.app probes — its
// sources reference far more constants than the stand-in carries.
const FIXTURE_BUILTIN_CONSTANTS_XLF = path.resolve(
  __dirname,
  "../fixtures/builtin-constants/4D_ConstantsEN.xlf"
);

export function builtinConstantsProbesFor(projectRoot: string, defaultProbes: string[]): string[] {
  if (path.resolve(projectRoot) === DEFAULT_FIXTURE) {
    return [FIXTURE_BUILTIN_CONSTANTS_XLF, ...defaultProbes];
  }
  return defaultProbes;
}

export function describeWithFixture(
  name: string,
  fn: (root: string) => void
): void {
  const root = resolveFixture();
  if (root) {
    describe(name, () => fn(root));
  } else {
    describe.skip(`${name} (no 4D fixture — set FOURD_TEST_PROJECT)`, () => {
      fn("");
    });
  }
}
