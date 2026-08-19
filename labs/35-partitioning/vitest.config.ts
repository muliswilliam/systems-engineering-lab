import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // Every test file in this lab reseeds/mutates the SAME flat and
    // partitioned tables (drops/re-creates partitions, deletes/inserts rows
    // to reproduce the missing-partition error, measures DETACH+DROP vs
    // DELETE timing) - running test files in parallel worker threads against
    // the same Postgres instance would let one file's mutation invalidate
    // another file's partition-layout assumptions mid-run. Same reasoning as
    // Lab 29/30/31/34.
    fileParallelism: false,
  },
});
