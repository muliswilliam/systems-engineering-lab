import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Real streaming replication lag and pg_stat_replication readiness are
    // being asserted here, not mocked - generous timeouts avoid flakiness on
    // a loaded machine without hiding a genuine replication problem.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
