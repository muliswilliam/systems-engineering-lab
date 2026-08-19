import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { runConcurrently, countFulfilled } from "@labs/test-utils";
import { createRedisClient, waitForRedis } from "../cache/redis-client.js";
import { createProductReader } from "../db/product-repository.js";
import { createNaiveCache } from "../cache/naive-cache-aside.js";
import { productCacheKey } from "../cache/cache-key.js";

const log = createLogger("lab21:scenario:naive-stampede");

const CONCURRENT_REQUESTS = 300;

async function pickProductId(pool: ReturnType<typeof createPool>): Promise<number> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM products ORDER BY id LIMIT 1");
  if (!rows[0]) {
    throw new Error("No products found - run `pnpm seed` first");
  }
  return Number(rows[0].id);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
    throw new Error("DATABASE_URL/REDIS_URL not set - copy .env.example to .env first");
  }

  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);
  const redis = createRedisClient(process.env.REDIS_URL);
  await waitForRedis(redis);

  const productId = await pickProductId(pool);
  await redis.del(productCacheKey(productId)); // force a COLD cache

  const reader = createProductReader(pool);
  const cache = createNaiveCache(redis, reader.getProductFromDatabase);

  log.info({ productId, concurrentRequests: CONCURRENT_REQUESTS }, "starting naive cache-aside stampede");

  const start = Date.now();
  const results = await runConcurrently(CONCURRENT_REQUESTS, () => cache.getProduct(productId));
  const elapsedMs = Date.now() - start;

  log.warn(
    {
      productId,
      concurrentRequests: CONCURRENT_REQUESTS,
      succeeded: countFulfilled(results),
      databaseCallCount: reader.getCallCount(),
      elapsedMs,
    },
    reader.getCallCount() > 1
      ? "STAMPEDE CONFIRMED: the cold-cache burst caused more than one database call for the same product"
      : "unexpected: only one database call happened - the stampede did not reproduce this run",
  );

  await redis.quit();
  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "naive stampede scenario failed");
    process.exit(1);
  });
}
