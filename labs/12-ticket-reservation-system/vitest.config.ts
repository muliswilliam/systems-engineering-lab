import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // This lab's concurrency tests each open up to 100+ real Postgres
    // connections at once (per-attempt connections, not a shared pool - see
    // README "Architecture"). Running test *files* in parallel would stack
    // multiple such bursts on top of each other and risk exhausting
    // max_connections even at 300; running them sequentially keeps each
    // burst isolated and reproducible.
    fileParallelism: false,
  },
});
