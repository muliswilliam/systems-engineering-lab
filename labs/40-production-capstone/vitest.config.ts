import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Several test files claim outbox events globally (SKIP LOCKED scans the
    // whole table) and share the one Redis instance's rate-limiter keys -
    // running test FILES concurrently would let one file's scratch state
    // leak into another file's assertions, the same reasoning Lab 17's
    // vitest.config.ts documents. Each file still manages and cleans up its
    // own scratch rows/keys.
    fileParallelism: false,
  },
});
