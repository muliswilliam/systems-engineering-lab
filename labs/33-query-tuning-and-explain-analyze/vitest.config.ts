import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Every test file's beforeAll reseeds the same small deterministic
    // dataset and applies migrations against the same database - running
    // test files in parallel would race those beforeAll hooks against each
    // other (see Lab 04's vitest.config.ts for the same reasoning).
    fileParallelism: false,
  },
});
