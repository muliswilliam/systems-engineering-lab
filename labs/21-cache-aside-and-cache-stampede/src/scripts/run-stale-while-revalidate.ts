import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { createRedisClient, waitForRedis } from "../cache/redis-client.js";
import { createProductReader, SIMULATED_QUERY_DELAY_MS } from "../db/product-repository.js";
import { createNaiveCache } from "../cache/naive-cache-aside.js";
import { createStaleWhileRevalidateCache } from "../cache/stale-while-revalidate.js";
import { productCacheKey, sleep } from "../cache/cache-key.js";

const log = createLogger("lab21:scenario:stale-while-revalidate");

const FRESH_MS = 300;
const STALE_MS = 5_000;

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
  const key = productCacheKey(productId);

  // --- Baseline: naive cache-aside pays the full database latency on EVERY miss ---
  await redis.del(key);
  const naiveReader = createProductReader(pool);
  const naiveCache = createNaiveCache(redis, naiveReader.getProductFromDatabase);

  const naiveColdStart = Date.now();
  await naiveCache.getProduct(productId);
  const naiveColdMs = Date.now() - naiveColdStart;

  await redis.del(key); // simulate the key expiring again
  const naiveMissStart = Date.now();
  await naiveCache.getProduct(productId);
  const naiveMissMs = Date.now() - naiveMissStart;

  log.info(
    { simulatedDatabaseDelayMs: SIMULATED_QUERY_DELAY_MS, naiveColdMs, naiveMissMs },
    "naive cache-aside: every miss pays the full simulated database latency",
  );

  // --- Stale-while-revalidate: a request after the FRESH window (but within the STALE window) is fast ---
  await redis.del(key);
  const swrReader = createProductReader(pool);
  const swrCache = createStaleWhileRevalidateCache(redis, swrReader.getProductFromDatabase, {
    freshMs: FRESH_MS,
    staleMs: STALE_MS,
  });

  await swrCache.getProduct(productId); // cold populate (pays full latency once)
  await sleep(FRESH_MS + 20); // let the FRESH window lapse - value is now stale but still cached

  const staleStart = Date.now();
  const staleValue = await swrCache.getProduct(productId);
  const staleReadMs = Date.now() - staleStart;

  // Give the background refresh (kicked off by the read above) time to complete.
  while (swrCache.isRefreshing(productId)) {
    await sleep(10);
  }

  const freshStart = Date.now();
  const freshValue = await swrCache.getProduct(productId);
  const freshReadMs = Date.now() - freshStart;

  log.info(
    {
      simulatedDatabaseDelayMs: SIMULATED_QUERY_DELAY_MS,
      staleReadMs,
      freshReadMs,
      databaseCallCount: swrReader.getCallCount(),
      staleValue,
      freshValue,
    },
    staleReadMs < SIMULATED_QUERY_DELAY_MS
      ? "FIXED: the stale read returned in well under the simulated database latency, and a subsequent read after the background refresh is also fast"
      : "unexpected: the stale read took as long as a full database call - stale-while-revalidate did not behave as expected this run",
  );

  await redis.quit();
  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "stale-while-revalidate scenario failed");
    process.exit(1);
  });
}
