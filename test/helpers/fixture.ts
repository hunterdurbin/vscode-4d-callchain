import * as fs from "node:fs";
import * as path from "node:path";
import { describe } from "vitest";

// Default to the committed mini-fixture under test/fixtures/mini-4d/. Set
// FOURD_TEST_PROJECT=/path/to/symphony to run against a larger real project
// for volume-style coverage; the curated mini-fixture is the source of truth
// for deterministic regression assertions.
const DEFAULT_FIXTURE = path.resolve(__dirname, "../fixtures/mini-4d");

export function resolveFixture(): string | null {
  const candidate = process.env.FOURD_TEST_PROJECT ?? DEFAULT_FIXTURE;
  if (!candidate) return null;
  return fs.existsSync(path.join(candidate, "Project")) ? candidate : null;
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
