import "dotenv/config";
import { Redis } from "ioredis";

/**
 * A small local connection helper - this lab's only Redis-touching code, not
 * a shared package, since no other lab in this repository depends on Redis
 * yet and CLAUDE.md's independent-labs principle says shared packages should
 * hold generic utilities, not scenario-specific wiring. If a second Redis lab
 * later needs the exact same helper, it is worth promoting to
 * `packages/db-utils`-style shared package then, not before.
 */
export function createRedisClient(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL is not set - copy .env.example to .env first");
  }
  return new Redis(url, {
    // Fail fast in scenario/test scripts rather than retrying forever against
    // a Redis that never comes up - `waitForRedis` below is the intended way
    // to wait for startup, not infinite reconnect attempts on every command.
    maxRetriesPerRequest: 3,
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
