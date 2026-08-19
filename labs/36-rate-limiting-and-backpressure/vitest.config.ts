import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The naive-overload and unbounded-queue-growth tests each drive a real
    // burst of concurrent work against shared in-process resources
    // (BoundedResource / the unbounded array queue) - running test files in
    // parallel would let one file's burst interfere with another's timing.
    fileParallelism: false,
  },
});
