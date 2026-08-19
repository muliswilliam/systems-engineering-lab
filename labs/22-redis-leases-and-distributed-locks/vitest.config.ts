import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Every scenario coordinates on a small set of fixed, named
    // "Scenario Resource - ..." rows (see src/seed/scenario-resources.ts)
    // plus fixed Redis lock/fencing keys derived from those names. Running
    // test files in parallel workers would let two files race on the same
    // Redis key or resource_state row and corrupt each other's before/after
    // readings, so this lab runs its integration tests sequentially - the
    // same reasoning Lab 07 and Lab 13 apply for the same reason.
    fileParallelism: false,
  },
});
