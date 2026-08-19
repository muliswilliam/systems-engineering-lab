import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // This lab's tests deliberately open dozens of real, concurrent
    // connections against a shared Postgres configured with a small
    // max_connections (see .env.example). Running multiple test files in
    // parallel would make them compete for that same connection budget and
    // produce flaky, cross-file interference - so test files run
    // sequentially here (tests within a single describe block still run
    // concurrently against each other where relevant, e.g. runConcurrently).
    fileParallelism: false,
  },
});
