import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Every test file's beforeAll applies migrations against the same
    // database and several tests query aggregate counts across the whole
    // outbox_events/orders tables - running test files in parallel would
    // race those queries against each other (same reasoning as Lab 05's
    // vitest.config.ts).
    fileParallelism: false,
  },
});
