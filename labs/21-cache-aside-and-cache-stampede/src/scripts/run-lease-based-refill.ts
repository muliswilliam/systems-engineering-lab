import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { runConcurrently, countFulfilled } from "@labs/test-utils";
import { createRedisClient, waitForRedis } from "../cache/redis-client.js";
import { createProductReader } from "../db/product-repository.js";
import { createLeaseBasedCache } from "../cache/lease-based-refill.js";
import { productCacheKey } from "../cache/cache-key.js";

const log = createLogger("lab21:scenario:lease-based-refill");

const SIMULATED_PROCESSES = 5;
const REQUESTS_PER_PROCESS = 60; // 5 x 60 = 300, matching the other two scenarios' total

async function pickProductId(pool: ReturnType<typeof createPool>): Promise<number> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM products ORDER BY id LIMIT 1");
  if (!rows[0]) {
    throw new Error("No products found - run `pnpm seed` first");
  }
  return Number(rows[0].id);
}

/**
 * Simulates multiple application processes the way Labs 05-19 simulate
 * multiple sessions: multiple independent `ioredis` connections, each with
 * ITS OWN `createLeaseBasedCache` instance (so no in-process state - like
 * request-coalescing's `inFlight` map - is shared between "processes").
 * The only thing coordinating them is the lease key in Redis itself.
 */
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
    throw new Error("DATABASE_URL/REDIS_URL not set - copy .env.example to .env first");
  }

  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  const productId = await pickProductId(pool);

  const bootstrapRedis = createRedisClient(process.env.REDIS_URL);
  await waitForRedis(bootstrapRedis);
  await bootstrapRedis.del(productCacheKey(productId)); // force a COLD cache

  const reader = createProductReader(pool);

  const simulatedProcesses = await Promise.all(
    Array.from({ length: SIMULATED_PROCESSES }, async () => {
      const redis = createRedisClient(process.env.REDIS_URL!);
      await waitForRedis(redis);
      return { redis, cache: createLeaseBasedCache(redis, reader.getProductFromDatabase) };
    }),
  );

  log.info(
    { productId, simulatedProcesses: SIMULATED_PROCESSES, requestsPerProcess: REQUESTS_PER_PROCESS },
    "starting lease-based-refill burst across simulated processes (same cold-cache setup as the other two scenarios)",
  );

  const start = Date.now();
  const allResults = await Promise.all(
    simulatedProcesses.map(({ cache }) => runConcurrently(REQUESTS_PER_PROCESS, () => cache.getProduct(productId))),
  );
  const elapsedMs = Date.now() - start;

  const totalSucceeded = allResults.reduce((sum, results) => sum + countFulfilled(results), 0);

  log.info(
    {
      productId,
      totalRequests: SIMULATED_PROCESSES * REQUESTS_PER_PROCESS,
      succeeded: totalSucceeded,
      databaseCallCount: reader.getCallCount(),
      elapsedMs,
    },
    reader.getCallCount() <= 2
      ? `FIXED (cross-process): ${reader.getCallCount()} database call(s) served the entire burst across ${SIMULATED_PROCESSES} simulated processes`
      : `unexpected: ${reader.getCallCount()} database calls happened - more than the documented narrow-race tolerance of 2`,
  );

  await bootstrapRedis.quit();
  await Promise.all(simulatedProcesses.map(({ redis }) => redis.quit()));
  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "lease-based-refill scenario failed");
    process.exit(1);
  });
}
