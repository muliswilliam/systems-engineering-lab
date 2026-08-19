import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { runConcurrently } from "@labs/test-utils";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { drizzle } from "drizzle-orm/node-postgres";
import { createRedisClient, waitForRedis } from "../redis/redis-client.js";
import { createSlidingWindowLimiter } from "../rate-limit/sliding-window.js";
import { rateLimitEvents } from "../db/schema.js";

const log = createLogger("lab36:scenario:rate-limit-sliding-window");

const WINDOW_MS = 1_000;
const LIMIT = 100;
const BURST_SIZE = 120;
const CLIENT_KEY = "demo-client";

/**
 * The exact scenario the task brief asks for: "120 requests in 1 second
 * against a 100/sec limit -> exactly 100 allowed, 20 rejected." A sliding
 * window log counts real requests inside a continuously-moving 1-second
 * window, so - unlike a fixed window counter that resets on a wall-clock
 * boundary and could let up to ~2x the limit through across that boundary -
 * this stays exact no matter when the burst happens to land.
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

  const limiter = createSlidingWindowLimiter(redis, { windowMs: WINDOW_MS, limit: LIMIT });

  log.info({ windowMs: WINDOW_MS, limit: LIMIT, burstSize: BURST_SIZE }, "starting sliding-window burst");

  const start = Date.now();
  const decisions = await runConcurrently(BURST_SIZE, () => limiter.check(CLIENT_KEY));
  const elapsedMs = Date.now() - start;

  const allowed = decisions.filter((d) => d.status === "fulfilled" && d.value.allowed).length;
  const rejected = decisions.length - allowed;

  await db.insert(rateLimitEvents).values(
    decisions
      .filter((d): d is PromiseFulfilledResult<{ allowed: boolean; detail: number }> => d.status === "fulfilled")
      .map((d) => ({ clientKey: CLIENT_KEY, algorithm: "sliding-window", allowed: d.value.allowed })),
  );

  log.warn(
    { burstSize: BURST_SIZE, limit: LIMIT, windowMs: WINDOW_MS, allowed, rejected, elapsedMs },
    allowed === LIMIT && rejected === BURST_SIZE - LIMIT
      ? "RATE LIMIT ENFORCED EXACTLY: allowed count matches the configured limit, no more, no less"
      : "unexpected: allowed/rejected counts did not exactly match the limit",
  );

  await redis.quit();
  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "sliding-window rate-limit scenario failed");
    process.exit(1);
  });
}
