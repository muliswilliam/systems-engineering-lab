import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Real streaming replication lag and pg_stat_replication readiness are
    // being asserted here, not mocked - generous timeouts avoid flakiness on
    // a loaded machine without hiding a genuine replication problem.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Several test files mutate the REPLICA-WIDE `recovery_min_apply_delay`
    // setting via ALTER SYSTEM (see src/lib/replication-control.ts). That
    // setting is shared, mutable, global state on one Postgres node - if
    // Vitest ran test files in parallel workers, one file's
    // setReplicaApplyDelay(...) could stomp on another file's in-flight
    // measurement. Running test files sequentially (not test CASES within a
    // file - those still run in the order written) avoids that real cross-file
    // race without needing any lab-specific locking mechanism.
    fileParallelism: false,
  },
});
