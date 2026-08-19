import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Real streaming replication, real recovery_min_apply_delay changes, and
    // real repeated-trial polling are being exercised here, not mocked -
    // generous timeouts avoid flakiness on a loaded machine without hiding a
    // genuine replication problem. Tests run sequentially (not per-file
    // parallel) because several files mutate the replica's shared
    // recovery_min_apply_delay GUC and must not race each other.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
