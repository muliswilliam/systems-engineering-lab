import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Every test file's beforeAll reseeds the same deterministic inventory
    // catalog and applies migrations against the same database - running
    // test files in parallel would race those beforeAll hooks against each
    // other (same reasoning as Labs 03/04/05's vitest.config.ts).
    fileParallelism: false,
  },
});
