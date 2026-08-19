import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Two/three-connection interleaving scenarios share fixed "Scenario
    // Account - ..." and "Scenario Staff - ..." rows by name (see
    // src/seed/scenario-data.ts) - running test files in parallel workers
    // would let two files race on the same rows and corrupt each other's
    // before/after readings, so this lab runs its integration tests
    // sequentially, same as Lab 07's isolation tests.
    fileParallelism: false,
  },
});
