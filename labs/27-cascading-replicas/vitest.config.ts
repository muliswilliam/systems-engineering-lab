import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Real streaming replication across two hops, plus an upstream-failure
    // test that stops and restarts a real Docker container, is being
    // exercised here, not mocked - generous timeouts avoid flakiness on a
    // loaded machine without hiding a genuine replication problem.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
