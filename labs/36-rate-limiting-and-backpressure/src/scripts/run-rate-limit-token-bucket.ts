import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { runConcurrently } from "@labs/test-utils";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { createRedisClient, waitForRedis } from "../redis/redis-client.js";
import { createTokenBucketLimiter } from "../rate-limit/token-bucket.js";
import { rateLimitEvents } from "../db/schema.js";
import { drizzle } from "drizzle-orm/node-postgres";

const log = createLogger("lab36:scenario:rate-limit-token-bucket");

const CAPACITY = 100;
const REFILL_PER_SECOND = 100;
const BURST_SIZE = 120;
const CLIENT_KEY = "demo-client";

/**
 * The rate-limiting fix: a real Redis-backed token bucket protecting the
 * service from a burst of REQUESTS, independent of how slow or fast the
 * downstream behind it is. A bucket starting full at 100 tokens, fired at by
 * 120 concurrent requests essentially simultaneously (negligible refill
 * during the burst), should let exactly 100 through and reject exactly 20 -
 * real, exact counts, not an approximation, because the Lua script's
 * check-and-decrement is atomic (see token-bucket.ts's doc comment).
 */
async function main(): Promise<void> {
  if (!process.env.REDIS_URL || !process.env.DATABASE_URL) {
    throw new Error("REDIS_URL/DATABASE_URL not set - copy .env.example to .env first");
  }

  const redis = createRedisClient(process.env.REDIS_URL);
  await waitForRedis(redis);
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);
  const db = drizzle(pool);

  const limiter = createTokenBucketLimiter(redis, { capacity: CAPACITY, refillPerSecond: REFILL_PER_SECOND });

  log.info(
    { capacity: CAPACITY, refillPerSecond: REFILL_PER_SECOND, burstSize: BURST_SIZE },
    "starting token-bucket burst",
  );

  const start = Date.now();
  const decisions = await runConcurrently(BURST_SIZE, () => limiter.check(CLIENT_KEY));
  const elapsedMs = Date.now() - start;

  const allowed = decisions.filter((d) => d.status === "fulfilled" && d.value.allowed).length;
  const rejected = decisions.length - allowed;

  await db.insert(rateLimitEvents).values(
    decisions
      .filter((d): d is PromiseFulfilledResult<{ allowed: boolean; detail: number }> => d.status === "fulfilled")
      .map((d) => ({ clientKey: CLIENT_KEY, algorithm: "token-bucket", allowed: d.value.allowed })),
  );

  log.warn(
    { burstSize: BURST_SIZE, capacity: CAPACITY, allowed, rejected, elapsedMs },
    allowed === CAPACITY && rejected === BURST_SIZE - CAPACITY
      ? "RATE LIMIT ENFORCED EXACTLY: allowed count matches bucket capacity, no more, no less"
      : "unexpected: allowed/rejected counts did not exactly match capacity - rerun with a larger gap between BURST_SIZE and CAPACITY if this persists",
  );

  await redis.quit();
  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "token-bucket rate-limit scenario failed");
    process.exit(1);
  });
}
