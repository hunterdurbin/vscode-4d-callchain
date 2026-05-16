import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true }
    },
    // Share module graph across test files in the same worker so the indexer
    // suites can reuse a single SymbolIndex (~25s build) instead of rebuilding
    // it per file. Pure unit tests have no shared state so this is safe.
    isolate: false,
    reporters: ["default"]
  }
});
