import { Redis } from "ioredis";

/**
 * A small Redis connection helper, kept LOCAL to this lab rather than
 * promoted to a shared package - the same reasoning Lab 21/22/36's own
 * independent copies document (no second consumer to justify generalizing
 * yet, and per the independent-labs principle none of those copies are
 * imported here either).
 */
export function createRedisClient(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: 5 });
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
