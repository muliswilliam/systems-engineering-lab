import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Every test file's beforeAll reseeds the same small deterministic
    // dataset and applies migrations against the same database - running
    // test files in parallel would race those beforeAll hooks against each
    // other (see Lab 03's vitest.config.ts for the same reasoning).
    fileParallelism: false,
  },
});
