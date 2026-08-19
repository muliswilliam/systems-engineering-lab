import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Every test file's beforeAll applies migrations against the same
    // database, and the concurrency tests below depend on precise
    // before/after balance arithmetic against accounts they create
    // themselves - running test files in parallel would race those
    // beforeAll hooks (same reasoning as Labs 03/04/05's vitest.config.ts).
    fileParallelism: false,
  },
});
