import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Every test file's beforeAll reseeds the same deterministic dataset via
    // seed-helper.ts (this lab's queries need the whole dataset present, not
    // isolated marker rows like Lab 02's constraint tests) - running test
    // files in parallel would race two beforeAll hooks against the same
    // unique public_id/email values. Sequential files keep the seed
    // deterministic without needing per-file data isolation.
    fileParallelism: false,
  },
});
