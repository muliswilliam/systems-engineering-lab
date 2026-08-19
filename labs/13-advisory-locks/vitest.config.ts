import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Every scenario coordinates on the same two fixed "Scenario Company -
    // ..." rows and their payroll_runs row (see src/seed/scenario-companies.ts)
    // by name, not by a freshly-created row per test - running test files in
    // parallel workers would let two files race on the same advisory-lock key
    // and corrupt each other's before/after readings, so this lab runs its
    // integration tests sequentially, the same way Lab 07 does for the same
    // reason.
    fileParallelism: false,
  },
});
