import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { runConcurrently, countFulfilled } from "@labs/test-utils";
import { pool } from "../../src/db/client.js";
import { createProductReader } from "../../src/db/product-repository.js";
import { createLeaseBasedCache } from "../../src/cache/lease-based-refill.js";
import { productCacheKey } from "../../src/cache/cache-key.js";
import { setupDatabase, insertTestProduct, createTestRedisClient } from "./test-helpers.js";

const SIMULATED_PROCESSES = 5;
const REQUESTS_PER_PROCESS = 50; // 5 x 50 = 250, matching the other two stampede tests' total

let bootstrapRedis: Redis;
const processRedisClients: Redis[] = [];

beforeAll(async () => {
  await setupDatabase();
  bootstrapRedis = await createTestRedisClient();
});

afterEach(async () => {
  await Promise.all(processRedisClients.splice(0).map((redis) => redis.quit()));
});

afterAll(async () => {
  await bootstrapRedis.quit();
  await pool.end();
});

/**
 * Unlike request-coalescing.test.ts, this simulates MULTIPLE PROCESSES via
 * multiple independent `ioredis` connections, each with its own
 * `createLeaseBasedCache` instance - no in-process state is shared between
 * them, so this proves the coordination genuinely lives in Redis (the lease
 * key), not in any one process's memory.
 */
describe("lease-based-refill cache (cross-process)", () => {
  it(`calls the database close to once for ${SIMULATED_PROCESSES * REQUESTS_PER_PROCESS} concurrent cold-cache requests spread across ${SIMULATED_PROCESSES} simulated processes`, async () => {
    const productId = await insertTestProduct("Leased Widget", 6_999);
    await bootstrapRedis.del(productCacheKey(productId));

    const reader = createProductReader(pool);

    const simulatedProcesses = await Promise.all(
      Array.from({ length: SIMULATED_PROCESSES }, async () => {
        const redis = await createTestRedisClient();
        processRedisClients.push(redis);
        return createLeaseBasedCache(redis, reader.getProductFromDatabase);
      }),
    );

    const allResults = await Promise.all(
      simulatedProcesses.map((cache) => runConcurrently(REQUESTS_PER_PROCESS, () => cache.getProduct(productId))),
    );

    const totalSucceeded = allResults.reduce((sum, results) => sum + countFulfilled(results), 0);
    expect(totalSucceeded).toBe(SIMULATED_PROCESSES * REQUESTS_PER_PROCESS);

    // The lease (atomic `SET ... NX` in Redis) means at most one caller across
    // ALL simulated processes should ever call the database for this key.
    // Tolerance of 2: a narrow, documented race exists if a lease expires
    // (leaseMs) before its holder finishes writing the value AND releasing
    // the lock - a second caller could then acquire a fresh lease and issue
    // a second database call. leaseMs (2000ms) is set far above the
    // simulated database delay (75ms) specifically to make this rare; it is
    // not eliminated by construction the way request-coalescing's in-process
    // single-flight is.
    expect(reader.getCallCount()).toBeLessThanOrEqual(2);
    expect(reader.getCallCount()).toBeGreaterThanOrEqual(1);
  });
});
