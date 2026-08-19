import type { Redis } from "ioredis";
import { sleep } from "./cache-key.js";

export interface JitterOptions {
  baseTtlMs: number;
  /** Fraction of baseTtlMs the actual TTL may deviate by, e.g. 0.2 = +/-20%. */
  jitterFraction: number;
}

/**
 * FIX #4: JITTERED TTL.
 *
 * `computeJitteredTtlMs` spreads a fixed base TTL across a
 * `[base * (1 - jitterFraction), base * (1 + jitterFraction)]` window
 * instead of returning the same value every time. Applied when many keys
 * are cached at (close to) the same instant - a cold start, a bulk cache
 * warm, a deploy that invalidates everything - this prevents them from all
 * expiring at (close to) the same instant, which is the setup for a
 * thundering herd of simultaneous misses even without any single "hot key."
 *
 * This module deliberately does NOT protect against a stampede on any ONE
 * key the way request coalescing or the lease do - it's a purely preventive,
 * cheap measure against correlated expiry across MANY keys. See README.md
 * "Fix it" for how the four mitigations in this lab compose.
 */
export function computeJitteredTtlMs(options: JitterOptions): number {
  const { baseTtlMs, jitterFraction } = options;
  const jitter = (Math.random() * 2 - 1) * jitterFraction * baseTtlMs;
  return Math.max(1, Math.round(baseTtlMs + jitter));
}

export function fixedTtlKey(index: number): string {
  return `jitter-demo:fixed:${index}`;
}

export function jitteredTtlKey(index: number): string {
  return `jitter-demo:jittered:${index}`;
}

/** Seeds `count` keys that all use the SAME fixed TTL, set at (as close as possible to) the same instant. */
export async function seedFixedTtlKeys(redis: Redis, count: number, baseTtlMs: number): Promise<void> {
  const pipeline = redis.pipeline();
  for (let i = 0; i < count; i += 1) {
    pipeline.set(fixedTtlKey(i), "v", "PX", baseTtlMs);
  }
  await pipeline.exec();
}

/** Seeds `count` keys whose TTLs are each independently jittered around the same base, set at (as close as possible to) the same instant. */
export async function seedJitteredTtlKeys(redis: Redis, count: number, options: JitterOptions): Promise<void> {
  const pipeline = redis.pipeline();
  for (let i = 0; i < count; i += 1) {
    pipeline.set(jitteredTtlKey(i), "v", "PX", computeJitteredTtlMs(options));
  }
  await pipeline.exec();
}

/**
 * Polls how many of `count` keys under `keyFn` still exist, at `intervalMs`
 * resolution, until none remain (or `maxWaitMs` elapses). Returns the
 * observed timestamps (relative to the call) at which the first key
 * disappeared and at which the last key disappeared - the real, measured
 * "expiration window" for that key set.
 */
export async function measureExpirationWindow(
  redis: Redis,
  keyFn: (index: number) => string,
  count: number,
  intervalMs: number,
  maxWaitMs: number,
): Promise<{ firstExpiryMs: number | null; lastExpiryMs: number | null }> {
  const start = Date.now();
  let firstExpiryMs: number | null = null;
  let lastExpiryMs: number | null = null;
  let previousRemaining = count;

  while (Date.now() - start < maxWaitMs) {
    const pipeline = redis.pipeline();
    for (let i = 0; i < count; i += 1) {
      pipeline.exists(keyFn(i));
    }
    const results = await pipeline.exec();
    const remaining = (results ?? []).reduce((sum, [, value]) => sum + (value === 1 ? 1 : 0), 0);

    const elapsed = Date.now() - start;
    if (remaining < previousRemaining && firstExpiryMs === null) {
      firstExpiryMs = elapsed;
    }
    if (remaining === 0) {
      lastExpiryMs = elapsed;
      break;
    }
    previousRemaining = remaining;
    await sleep(intervalMs);
  }

  return { firstExpiryMs, lastExpiryMs };
}
