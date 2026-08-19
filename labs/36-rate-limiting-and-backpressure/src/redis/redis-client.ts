import { Redis } from "ioredis";

/**
 * A small Redis-specific counterpart to `@labs/db-utils`'s
 * `createPool`/`waitForDatabase` for Postgres. Kept LOCAL to this lab rather
 * than promoted to a shared package - the same "no second consumer to
 * justify generalizing yet" reasoning Lab 21's own `redis-client.ts` and
 * Lab 22's independent copy document, since neither of those labs' helpers
 * is imported here either (per the independent-labs principle).
 */
export function createRedisClient(url: string): Redis {
  return new Redis(url, {
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
