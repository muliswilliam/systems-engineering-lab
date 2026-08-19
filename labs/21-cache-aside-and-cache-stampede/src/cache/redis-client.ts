import { Redis } from "ioredis";

/**
 * A small Redis-specific counterpart to `@labs/db-utils`'s
 * `createPool`/`waitForDatabase` for Postgres. This stays LOCAL to Lab 21
 * rather than moving into a shared package: at the time this lab was built,
 * Lab 22 (the only other lab that will need a Redis connection) does not
 * exist yet, and per CLAUDE.md's dependency guidance ("avoid speculative
 * shared machinery ahead of a second consumer needing it" - the same
 * reasoning Lab 05's `transfers` and Lab 17's `outbox_events` document) it
 * is simpler to duplicate ~15 lines here than to introduce a shared
 * `packages/redis-utils` (or grow `@labs/db-utils` beyond Postgres) for a
 * single caller. If Lab 22 needs the identical helper, promoting this file
 * to a shared package at that point is a trivial, well-motivated move.
 */
export function createRedisClient(url: string): Redis {
  return new Redis(url, {
    // Scenario/test scripts want explicit errors, not infinite silent
    // retries, if Redis is genuinely unreachable.
    maxRetriesPerRequest: 5,
  });
}

export async function waitForRedis(redis: Redis, attempts = 30, delayMs = 500): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await redis.ping();
      return;
    } catch (error) {
      if (attempt === attempts) {
        throw new Error(`Redis not reachable after ${attempts} attempts: ${String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
