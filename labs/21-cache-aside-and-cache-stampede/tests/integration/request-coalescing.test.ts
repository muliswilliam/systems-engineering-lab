import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { runConcurrently, countFulfilled } from "@labs/test-utils";
import { pool } from "../../src/db/client.js";
import { createProductReader } from "../../src/db/product-repository.js";
import { createCoalescingCache } from "../../src/cache/request-coalescing.js";
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

describe("request-coalescing cache", () => {
  it(`calls the database exactly once for ${CONCURRENT_REQUESTS} concurrent cold-cache requests for the same product`, async () => {
    const productId = await insertTestProduct("Coalesced Widget", 5_999);
    await redis.del(productCacheKey(productId));

    const reader = createProductReader(pool);
    const cache = createCoalescingCache(redis, reader.getProductFromDatabase);

    const results = await runConcurrently(CONCURRENT_REQUESTS, () => cache.getProduct(productId));

    expect(countFulfilled(results)).toBe(CONCURRENT_REQUESTS);
    expect(reader.getCallCount()).toBe(1);

    // Every concurrent caller got the SAME, correct product data - coalescing
    // shares one result, it doesn't just reduce the count of DB calls while
    // returning garbage to everyone else.
    for (const result of results) {
      expect(result.status).toBe("fulfilled");
      if (result.status === "fulfilled") {
        expect(result.value.id).toBe(productId);
        expect(result.value.name).toBe("Coalesced Widget");
      }
    }
  });
});
