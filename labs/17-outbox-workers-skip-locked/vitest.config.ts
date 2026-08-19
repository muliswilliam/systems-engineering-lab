import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Outbox claiming is deliberately global (the claim query scans the
    // whole `outbox_events` table, not just one test's rows) - running test
    // FILES concurrently against the same database would let one file's
    // scratch events be visible to another file's claim queries. Test files
    // still each manage their own scratch rows and clean up after
    // themselves; this only removes cross-file interleaving.
    fileParallelism: false,
  },
});
