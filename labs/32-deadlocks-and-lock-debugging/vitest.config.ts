import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Every test file in this lab drives real concurrent transactions
    // against the SAME `accounts` table (the two named scenario accounts,
    // plus many trial-pair accounts) - running test files in parallel worker
    // threads would let one file's account resets/balances race another
    // file's assertions, the same reasoning Lab 10/29/30/31 document for
    // their own vitest.config.ts.
    fileParallelism: false,
  },
});
