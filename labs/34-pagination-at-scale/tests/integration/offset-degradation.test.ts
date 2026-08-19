import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { explainKeysetPage, explainOffsetPage, getCursorAtOffset } from "../../src/scenarios/pagination-lib.js";
import { reseed } from "./test-helpers.js";

const ROWS = 60_000;
const PAGE_SIZE = 20;
const SHALLOW_OFFSET = 0;
const DEEP_OFFSET = 50_000;

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await reseed(pool, ROWS);
}, 180_000);

afterAll(async () => {
  await pool.end();
});

describe("OFFSET pagination degrades with depth even though an index exists", () => {
  it("uses the SAME index (Index Scan) at both shallow and deep offsets", async () => {
    const shallow = await explainOffsetPage(pool, SHALLOW_OFFSET, PAGE_SIZE);
    const deep = await explainOffsetPage(pool, DEEP_OFFSET, PAGE_SIZE);

    expect(shallow.topNodeType).toBe("Limit");
    expect(deep.topNodeType).toBe("Limit");
    // Both plans use the (created_at, id) index to avoid a sort - the index
    // is genuinely being used at every depth. The bug is NOT "no index" or
    // "wrong plan"; it's that using the index still costs O(offset).
    expect(JSON.stringify(shallow.raw)).toContain("Index Scan");
    expect(JSON.stringify(deep.raw)).toContain("Index Scan");
  });

  it("touches dramatically more buffers at a deep offset than a shallow one - a real, deterministic (non-flaky) cost metric", async () => {
    const shallow = await explainOffsetPage(pool, SHALLOW_OFFSET, PAGE_SIZE);
    const deep = await explainOffsetPage(pool, DEEP_OFFSET, PAGE_SIZE);

    const shallowBuffers = shallow.buffers.sharedHit + shallow.buffers.sharedRead;
    const deepBuffers = deep.buffers.sharedHit + deep.buffers.sharedRead;

    // The deep query must walk-and-discard ~50,000 preceding rows before
    // the Limit node ever returns anything - it necessarily touches far
    // more buffers than the shallow query, which is a direct, real,
    // deterministic measurement of the exact cost this lab is about
    // (buffer counts are stable across runs, unlike wall-clock timing).
    expect(deepBuffers).toBeGreaterThan(shallowBuffers * 10);
  });

  it("real EXPLAIN ANALYZE execution time is meaningfully higher at depth (median of repeated real runs)", async () => {
    const median = async (fn: () => Promise<number>): Promise<number> => {
      const samples = [await fn(), await fn(), await fn()].sort((a, b) => a - b);
      return samples[1]!;
    };

    const shallowMs = await median(async () => (await explainOffsetPage(pool, SHALLOW_OFFSET, PAGE_SIZE)).executionTimeMs);
    const deepMs = await median(async () => (await explainOffsetPage(pool, DEEP_OFFSET, PAGE_SIZE)).executionTimeMs);

    expect(deepMs).toBeGreaterThan(shallowMs);
  });
});

describe("keyset pagination stays flat at the same depths", () => {
  it("touches roughly the same number of buffers regardless of depth", async () => {
    const cursorAtDeepOffset = await getCursorAtOffset(pool, DEEP_OFFSET - 1);

    const shallow = await explainKeysetPage(pool, null, PAGE_SIZE);
    const deep = await explainKeysetPage(pool, cursorAtDeepOffset, PAGE_SIZE);

    const shallowBuffers = shallow.buffers.sharedHit + shallow.buffers.sharedRead;
    const deepBuffers = deep.buffers.sharedHit + deep.buffers.sharedRead;

    // Keyset should NOT show the same order-of-magnitude growth OFFSET does.
    // A generous factor (not exactly 1x) accounts for real index-depth
    // differences (B-tree height, page splits) - the point is "flat", not
    // "byte-identical."
    expect(deepBuffers).toBeLessThan(shallowBuffers * 5 + 20);
  });
});
