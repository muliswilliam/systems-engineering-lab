import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Two-connection interleaving scenarios share fixed "Scenario Account -
    // ..." rows by name (see src/seed/seed.ts) - running test files in
    // parallel workers would let two files race on the same row and corrupt
    // each other's before/after readings, so this lab runs its integration
    // tests sequentially, same as the isolation guarantee it's demonstrating.
    fileParallelism: false,
  },
});
