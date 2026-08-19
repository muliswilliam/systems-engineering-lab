import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Real streaming replication, a real container stop, a real pg_promote()
    // call, and (in failover-promotion.test.ts's afterAll) a full real
    // `docker compose down -v && up -d` reset cycle are being exercised
    // here, not mocked - generous timeouts avoid flakiness on a loaded
    // machine without hiding a genuine problem. Bitnami's from-scratch
    // bootstrap (base backup + first streaming connection) is the slowest
    // real step, hence 120s rather than this repository's more typical 30s.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // This lab's test files mutate real, shared cluster state (one test file
    // genuinely stops the primary container and promotes the replica). That
    // is fundamentally not safe to run INTERLEAVED with other test files
    // against the SAME cluster, so file-level parallelism is disabled and
    // files run one at a time. Vitest does not guarantee file discovery
    // order matches alphabetical sort (observed: failover-promotion.test.ts
    // actually ran before baseline-replication.test.ts in this lab's own
    // validation run) - each file's own `beforeAll` is therefore written to
    // be self-sufficient regardless of which order it runs in, and
    // failover-promotion.test.ts's `afterAll` always leaves the cluster back
    // in a fresh, healthy, non-promoted state for whichever file runs next.
    fileParallelism: false,
  },
});
