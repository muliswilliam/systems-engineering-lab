import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Every test file in this lab seeds/mutates the SAME `activity_events`
    // table (inserts/deletes used to reproduce the OFFSET skip/duplicate
    // bug, plus the shared row count the degradation assertions depend on)
    // - running test files in parallel worker threads against the same
    // Postgres instance would let one file's mutations corrupt another
    // file's row-position assumptions mid-run. Same reasoning as Lab 29/30/31.
    fileParallelism: false,
  },
});
