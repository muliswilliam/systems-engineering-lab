import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Every test file starts its own in-process HTTP server on the SAME
    // fixed APP_PORT and reads/writes the SAME structured/naive log files -
    // running test files in parallel worker threads would double-bind the
    // port and interleave log lines across files, the same reasoning Lab
    // 29/30/31's vitest.config.ts document for their own shared mutable state.
    fileParallelism: false,
  },
});
