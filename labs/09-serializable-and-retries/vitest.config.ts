import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Every scenario resets and targets a fixed, named set of "Scenario Staff -
    // ..." rows (see src/seed/scenario-staff.ts). Two test files racing on the
    // same team's rows in parallel workers would corrupt each other's
    // before/after readings, so - same as Lab 07 - this lab runs its
    // integration tests sequentially.
    fileParallelism: false,
  },
});
