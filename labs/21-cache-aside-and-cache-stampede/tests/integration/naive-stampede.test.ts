import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { runConcurrently, countFulfilled } from "@labs/test-utils";
import { pool } from "../../src/db/client.js";
import { createProductReader } from "../../src/db/product-repository.js";
import { createNaiveCache } from "../../src/cache/naive-cache-aside.js";
import { productCacheKey } from "../../src/cache/cache-key.js";
import { setupDatabase, insertTestProduct, createTestRedisClient } from "./test-helpers.js";

const CONCURRENT_REQUESTS = 250;

let redis: Redis;

beforeAll(async () => {
  await setupDatabase();
  redis = await createTestRedisClient();
});

afterAll(async () => {
  await redis.quit();
  await pool.end();
});

/**
 * Proves the cache stampede is real, per CLAUDE.md's "show failure before
 * the fix": a cold-cache burst of concurrent requests for the SAME product
 * calls the slow database function far more than once, because every
 * concurrent caller independently misses before any of them finishes
 * populating the cache.
 */
describe("naive cache-aside (no stampede protection)", () => {
  it(`calls the database more than once for ${CONCURRENT_REQUESTS} concurrent cold-cache requests for the same product`, async () => {
    const productId = await insertTestProduct("Naive Stampede Widget", 4_999);
    await redis.del(productCacheKey(productId));

    const reader = createProductReader(pool);
    const cache = createNaiveCache(redis, reader.getProductFromDatabase);

    const results = await runConcurrently(CONCURRENT_REQUESTS, () => cache.getProduct(productId));

    expect(countFulfilled(results)).toBe(CONCURRENT_REQUESTS);
    // The bug, as an assertion: a real stampede, not a theoretical one.
    expect(reader.getCallCount()).toBeGreaterThan(1);
  });
});
