import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { runConcurrently } from "@labs/test-utils";
import { createRedisClient, waitForRedis } from "../redis/redis-client.js";
import { createTokenBucketLimiter } from "../lib/rate-limiter.js";

const log = createLogger("lab40:scenario:rate-limit");

/**
 * The rate limiter that guards the checkout API boundary, exercised on its
 * own (Lab 36's mechanism, reused fresh): a 120-concurrent-request burst
 * against a 100-capacity/100-per-second token bucket. This is a SEPARATE
 * concern from idempotency - it protects Postgres and the rest of the
 * pipeline from an oversized burst of DISTINCT customers checking out at
 * once, regardless of whether any of them are duplicates. See README
 * "Architecture" for why this capstone keeps the two mechanisms distinct
 * rather than conflating "too many requests" with "the same request too
 * many times."
 */
async function main(): Promise<void> {
  if (!process.env.REDIS_URL) {
    throw new Error("REDIS_URL is not set - copy .env.example to .env first");
  }
  const redis = createRedisClient(process.env.REDIS_URL);
  await waitForRedis(redis);
  await redis.del("lab40:ratelimit:checkout-api");

  const limiter = createTokenBucketLimiter(redis, { capacity: 100, refillPerSecond: 100 });

  const BURST_SIZE = 120;
  const start = Date.now();
  const results = await runConcurrently(BURST_SIZE, () => limiter.check("checkout-api"));
  const durationMs = Date.now() - start;

  const allowed = results.filter((r) => r.status === "fulfilled" && r.value.allowed).length;
  const rejected = BURST_SIZE - allowed;

  log.info(
    { burstSize: BURST_SIZE, allowed, rejected, durationMs },
    allowed === 100 && rejected === 20
      ? "EXACT split observed: 100 allowed, 20 rejected - matches the configured capacity exactly"
      : `observed ${allowed} allowed / ${rejected} rejected`,
  );

  await redis.quit();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "rate limit burst scenario failed");
    process.exit(1);
  });
}
