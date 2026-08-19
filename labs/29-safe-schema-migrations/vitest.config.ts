import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // This lab's tests hold real Postgres locks open across separate pg
    // Client connections and make wall-clock assertions about blocking vs.
    // non-blocking DDL (CREATE INDEX vs CREATE INDEX CONCURRENTLY,
    // lock_timeout). Running test files in parallel worker threads against
    // the same Postgres instance would let one file's held lock bleed into
    // another file's timing assertions - so this lab runs test files
    // sequentially, trading a bit of wall-clock test time for reliable,
    // non-flaky lock-timing assertions.
    fileParallelism: false,
  },
});
