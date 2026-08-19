import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { runConcurrently, countFulfilled } from "@labs/test-utils";
import { createRedisClient, waitForRedis } from "../redis/redis-client.js";
import { createSlidingWindowLimiter } from "../rate-limit/sliding-window.js";
import { BoundedResource, callSlowDownstream } from "../downstream/slow-downstream.js";

const log = createLogger("lab36:scenario:rate-limit-insufficient");

// Deliberately generous: this limit will NOT be the bottleneck.
const RATE_LIMIT = 50;
const RATE_LIMIT_WINDOW_MS = 1_000;

// The real bottleneck: a slow downstream with only 3 concurrent slots and
// 800ms of latency per call - far less throughput than the rate limit alone
// would suggest is safe.
const DOWNSTREAM_CAPACITY = 3;
const DOWNSTREAM_LATENCY_MS = 800;
const ACQUIRE_TIMEOUT_MS = 500;

// Sent all at once, but well UNDER the rate limit (20 < 50) - the rate
// limiter has plenty of headroom and should reject nothing.
const REQUEST_COUNT = 20;
const CLIENT_KEY = "demo-client";

/**
 * The distinction the task brief asks for, made concrete: rate limiting
 * protects against too many INCOMING REQUESTS; backpressure protects
 * against too much IN-FLIGHT/QUEUED WORK. A system can have plenty of
 * rate-limit headroom (every request here is well under the configured
 * limit) and still be overloaded, because the requests that DO get through
 * are individually slow and the downstream has real, finite concurrency -
 * nothing here bounds how much work is in flight at once. Rate limiting and
 * backpressure are complementary controls, not substitutes for each other.
 */
async function main(): Promise<void> {
  if (!process.env.REDIS_URL) {
    throw new Error("REDIS_URL not set - copy .env.example to .env first");
  }
  const redis = createRedisClient(process.env.REDIS_URL);
  await waitForRedis(redis);

  const limiter = createSlidingWindowLimiter(redis, { windowMs: RATE_LIMIT_WINDOW_MS, limit: RATE_LIMIT });
  const resource = new BoundedResource(DOWNSTREAM_CAPACITY);

  log.info(
    {
      rateLimit: RATE_LIMIT,
      rateLimitWindowMs: RATE_LIMIT_WINDOW_MS,
      downstreamCapacity: DOWNSTREAM_CAPACITY,
      downstreamLatencyMs: DOWNSTREAM_LATENCY_MS,
      acquireTimeoutMs: ACQUIRE_TIMEOUT_MS,
      requestCount: REQUEST_COUNT,
    },
    "starting rate-limit-insufficient demo: requests stay well under the rate limit but still overload a slow, low-concurrency downstream",
  );

  const results = await runConcurrently(REQUEST_COUNT, async () => {
    const decision = await limiter.check(CLIENT_KEY);
    if (!decision.allowed) {
      throw new Error("rate limited");
    }
    await callSlowDownstream(resource, DOWNSTREAM_LATENCY_MS, ACQUIRE_TIMEOUT_MS);
  });

  const rateLimited = results.filter(
    (r) => r.status === "rejected" && String(r.reason).includes("rate limited"),
  ).length;
  const downstreamTimedOut = results.filter(
    (r) => r.status === "rejected" && !String(r.reason).includes("rate limited"),
  ).length;
  const succeeded = countFulfilled(results);

  log.warn(
    {
      requestCount: REQUEST_COUNT,
      rateLimit: RATE_LIMIT,
      rateLimited,
      downstreamTimedOut,
      succeeded,
    },
    rateLimited === 0 && downstreamTimedOut > 0
      ? "CONFIRMED: zero requests were rejected by the rate limiter (plenty of headroom), yet real downstream timeouts occurred - rate limiting alone did not prevent overload"
      : "unexpected: rerun, or adjust DOWNSTREAM_CAPACITY/ACQUIRE_TIMEOUT_MS to widen the gap between what the rate limiter allows and what the downstream can actually sustain",
  );

  await redis.quit();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "rate-limit-insufficient scenario failed");
    process.exit(1);
  });
}
