import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 90_000,
    // Every test file in this lab mutates the SAME `page_views` table's
    // autovacuum settings, dead-tuple count, and physical size to make its
    // own before/after assertions - running test files in parallel worker
    // threads against the same Postgres instance would let one file's
    // VACUUM/bloat state clobber another file's measurements, the same
    // reasoning Lab 29/30 document for their own vitest.config.ts.
    fileParallelism: false,
  },
});
