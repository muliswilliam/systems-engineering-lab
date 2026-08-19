import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // naive-leak.test.ts temporarily runs `ALTER TABLE ... DISABLE ROW
    // LEVEL SECURITY` (as the owning migrator role) to reproduce the real
    // cross-tenant leak, then re-enables it in a `finally`/`afterAll`. That
    // toggle is a database-wide, not per-connection, setting - running test
    // files in parallel worker threads against the same Postgres instance
    // would let one file's toggle bleed into another file's RLS-enforcement
    // assertions, so this lab runs test files sequentially (same reasoning
    // as Lab 29's vitest.config.ts).
    fileParallelism: false,
  },
});
