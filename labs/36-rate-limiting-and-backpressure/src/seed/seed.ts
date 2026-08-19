import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { jobs, queueState, rateLimitEvents } from "../db/schema.js";
import { createRedisClient, waitForRedis } from "../redis/redis-client.js";

const log = createLogger("lab36:seed");

const DEFAULT_QUEUE_CAPACITY = 50;

/**
 * Idempotent and deterministic like every other lab's seed script: clears
 * `jobs`/`rate_limit_events` and resets the single `queue_state` row to a
 * known capacity with `pending_count = 0` every run. It also `FLUSHDB`s
 * Redis every run (same reasoning as Lab 21's own seed script) - this lab's
 * entire point is rate-limiter/queue state, and a leftover token-bucket or
 * sliding-window key from a previous run would silently change which
 * branch a scenario or test exercises.
 *
 * There is no `--size`/`--rows` flag here (unlike most seed scripts in this
 * repo) - this lab has no bulk realistic dataset to generate, per its own
 * "generic protect-the-service mechanism, not a rich domain" scoping (see
 * README.md "Architecture"). Every scenario generates its own load at run
 * time instead.
 */
async function main() {
  await waitForDatabase(pool);

  log.info("clearing jobs and rate_limit_events");
  await db.delete(jobs);
  await db.delete(rateLimitEvents);

  log.info({ capacity: DEFAULT_QUEUE_CAPACITY }, "resetting queue_state");
  await db
    .insert(queueState)
    .values({ id: 1, capacity: DEFAULT_QUEUE_CAPACITY, pendingCount: 0 })
    .onConflictDoUpdate({
      target: queueState.id,
      set: { capacity: DEFAULT_QUEUE_CAPACITY, pendingCount: 0 },
    });

  if (!process.env.REDIS_URL) {
    throw new Error("REDIS_URL is not set - copy .env.example to .env first");
  }
  const redis = createRedisClient(process.env.REDIS_URL);
  await waitForRedis(redis);
  await redis.flushdb();
  await redis.quit();

  log.info("seed complete (jobs/rate_limit_events cleared, queue_state reset, Redis flushed)");
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
