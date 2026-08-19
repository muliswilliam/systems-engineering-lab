import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Every scenario in this lab resets and then races on one of a handful of
    // fixed "Scenario Document - ..." rows, looked up by title (see
    // src/seed/scenario-documents.ts). Running test files in parallel workers
    // would let two files race on the same document row and corrupt each
    // other's before/after readings, so integration tests run sequentially -
    // the same discipline the concurrency mechanisms themselves rely on.
    fileParallelism: false,
  },
});
