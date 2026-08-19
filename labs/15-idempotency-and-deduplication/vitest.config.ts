import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Every test file's beforeAll applies migrations against the same
    // database, and the concurrency tests below open many real connections
    // against the same payments table at once - running test files in
    // parallel would race those beforeAll hooks and pollute each other's
    // concurrent-attempt counts (same reasoning as Labs 05's vitest.config.ts).
    fileParallelism: false,
  },
});
