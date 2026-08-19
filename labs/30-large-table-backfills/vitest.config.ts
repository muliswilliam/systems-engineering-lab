import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Tests in this lab seed their own small scratch datasets and hold real
    // Postgres locks / spawn real child processes to prove resumability -
    // running test files in parallel worker threads against the same
    // Postgres instance would let one file's backfill run interfere with
    // another file's row counts and timing assertions, the same reasoning
    // Lab 29 documents for its own vitest.config.ts.
    fileParallelism: false,
  },
});
