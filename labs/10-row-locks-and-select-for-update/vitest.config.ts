import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Every scenario drives two (or three) explicit, interleaved connections
    // against fixed "Scenario Account - ..." rows looked up by name (see
    // src/seed/scenario-accounts.ts). Running test files in parallel workers
    // would let two files race on the same row and corrupt each other's
    // before/after readings - the exact opposite of what this lab is trying
    // to demonstrate about controlled interleaving - so tests run
    // sequentially, same as labs 05 and 07.
    fileParallelism: false,
  },
});
