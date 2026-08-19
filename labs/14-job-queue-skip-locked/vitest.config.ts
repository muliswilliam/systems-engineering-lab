import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // The 50-worker draining test and the lease-expiry test both need real
    // wall-clock time against a real Postgres instance - run test files
    // sequentially so concurrency scenarios don't compete with each other
    // for connections/CPU and produce flaky timings.
    fileParallelism: false,
  },
});
