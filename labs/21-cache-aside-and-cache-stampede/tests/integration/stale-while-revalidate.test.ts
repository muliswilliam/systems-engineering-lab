import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { pool } from "../../src/db/client.js";
import { createProductReader, SIMULATED_QUERY_DELAY_MS } from "../../src/db/product-repository.js";
import { createStaleWhileRevalidateCache } from "../../src/cache/stale-while-revalidate.js";
import { productCacheKey, sleep } from "../../src/cache/cache-key.js";
import { setupDatabase, insertTestProduct, createTestRedisClient } from "./test-helpers.js";

const FRESH_MS = 200;
const STALE_MS = 5_000;

let redis: Redis;

beforeAll(async () => {
  await setupDatabase();
  redis = await createTestRedisClient();
});

afterAll(async () => {
  await redis.quit();
  await pool.end();
});

describe("stale-while-revalidate cache", () => {
  it("serves a response in under the simulated database latency once the fresh TTL has expired, as long as a stale value exists, then serves fresh data after the background refresh completes", async () => {
    const productId = await insertTestProduct("Stale Widget v1", 1_000);
    await redis.del(productCacheKey(productId));

    const reader = createProductReader(pool);
    const cache = createStaleWhileRevalidateCache(redis, reader.getProductFromDatabase, {
      freshMs: FRESH_MS,
      staleMs: STALE_MS,
    });

    // Cold populate - pays full latency once.
    const initial = await cache.getProduct(productId);
    expect(initial.name).toBe("Stale Widget v1");
    expect(reader.getCallCount()).toBe(1);

    // Let the fresh window lapse (value is now stale but still cached).
    await sleep(FRESH_MS + 20);

    const staleStart = Date.now();
    const staleValue = await cache.getProduct(productId);
    const staleReadMs = Date.now() - staleStart;

    // The stale read must be fast - it must NOT have waited on the slow
    // database call, even though the fresh TTL already expired.
    expect(staleReadMs).toBeLessThan(SIMULATED_QUERY_DELAY_MS);
    expect(staleValue.name).toBe("Stale Widget v1");

    // Wait for the background refresh triggered by the stale read above.
    while (cache.isRefreshing(productId)) {
      await sleep(10);
    }
    expect(reader.getCallCount()).toBe(2);

    // A subsequent request now gets the fresh (still identical, since the
    // underlying row hasn't changed) value, fast, with no further DB calls.
    const freshValue = await cache.getProduct(productId);
    expect(freshValue.name).toBe("Stale Widget v1");
    expect(reader.getCallCount()).toBe(2);
  });
});
