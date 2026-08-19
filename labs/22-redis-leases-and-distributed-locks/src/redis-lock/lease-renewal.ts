import "dotenv/config";
import { fileURLToPath } from "node:url";
import type { Redis } from "ioredis";
import { createLogger } from "@labs/logging";
import { createRedisClient, waitForRedis } from "./redis-client.js";
import { acquireLock, releaseLock } from "./basic-lock.js";
import { randomToken, sleep } from "./support.js";

const log = createLogger("lab22:redis-lock:lease-renewal");

/**
 * The "proper" alternative to fencing tokens for genuinely long-running
 * work: periodically extend (renew) the lease's TTL while work is still in
 * progress - a heartbeat - so a holder that is really still alive and
 * working never loses its lock in the first place. Atomic, same shape as
 * releaseLock: only extends if the caller's token still matches, so a
 * worker that has already lost the lock cannot accidentally "steal back"
 * a TTL extension on a key someone else now owns.
 */
const RENEW_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end
`;

export async function renewLock(redis: Redis, key: string, ownerToken: string, ttlMs: number): Promise<boolean> {
  const result = await redis.eval(RENEW_SCRIPT, 1, key, ownerToken, String(ttlMs));
  return result === 1;
}

export interface SuccessfulRenewalResult {
  ttlMs: number;
  renewIntervalMs: number;
  workDurationMs: number;
  renewalCount: number;
  lockHeldThroughout: boolean;
  competitorAcquiredDuringWork: boolean;
}

/**
 * Renewal working as intended: the holder renews well before every TTL
 * expiry, so a competitor's acquire attempt midway through the work fails,
 * and the original holder still holds the exact same key/token at the end -
 * contrast with lease-expiry-bug.ts, where the identical shape of "long
 * work, short TTL" causes a double-acquisition because nothing renews.
 */
export async function demonstrateSuccessfulRenewal(
  redis: Redis,
  key: string,
  ttlMs: number,
  renewIntervalMs: number,
  workDurationMs: number,
): Promise<SuccessfulRenewalResult> {
  await redis.del(key);
  const ownerToken = randomToken();
  const acquired = await acquireLock(redis, key, ownerToken, ttlMs);
  if (!acquired) {
    throw new Error("setup failure: could not acquire lock");
  }

  let renewalCount = 0;
  let renewing = true;
  const renewalTimer = setInterval(() => {
    if (!renewing) return;
    void renewLock(redis, key, ownerToken, ttlMs).then((ok) => {
      if (ok) renewalCount += 1;
    });
  }, renewIntervalMs);

  const competitorCheck = (async () => {
    await sleep(Math.floor(workDurationMs / 2));
    const competitorToken = randomToken();
    return acquireLock(redis, key, competitorToken, ttlMs);
  })();

  await sleep(workDurationMs);
  renewing = false;
  clearInterval(renewalTimer);

  const competitorAcquiredDuringWork = await competitorCheck;
  const finalValue = await redis.get(key);
  const lockHeldThroughout = finalValue === ownerToken;

  await releaseLock(redis, key, ownerToken);

  return {
    ttlMs,
    renewIntervalMs,
    workDurationMs,
    renewalCount,
    lockHeldThroughout,
    competitorAcquiredDuringWork,
  };
}

export interface RenewalPauseResult {
  ttlMs: number;
  pauseMs: number;
  lockStolenDuringPause: boolean;
  renewalAfterPauseSucceeded: boolean;
}

/**
 * Renewal's honest limitation: it is best-effort. If the holder's process
 * cannot run its renewal loop for longer than the TTL - a long GC pause, a
 * suspended container, a blocked event loop - the lease still expires and a
 * competitor can still acquire it, exactly as in lease-expiry-bug.ts. When
 * the "paused" holder finally gets to renew, its token no longer matches
 * (a different owner now holds the key, or the key has moved on), so the
 * renewal correctly fails rather than silently reasserting a lock it no
 * longer owns. This is exactly why fencing tokens exist: they defend the
 * downstream write even in the case renewal cannot prevent.
 */
export async function demonstrateRenewalPauseAllowsTheft(
  redis: Redis,
  key: string,
  ttlMs: number,
  pauseMs: number,
): Promise<RenewalPauseResult> {
  await redis.del(key);
  const ownerToken = randomToken();
  await acquireLock(redis, key, ownerToken, ttlMs);

  // Simulate a GC pause / suspended process: the renewal loop simply does
  // not run for `pauseMs`, which is deliberately greater than `ttlMs`.
  await sleep(pauseMs);

  const competitorToken = randomToken();
  const lockStolenDuringPause = await acquireLock(redis, key, competitorToken, ttlMs);

  // The original holder "wakes up" and tries to renew as if nothing
  // happened - its token no longer matches whatever (if anything) now holds
  // the key, so the atomic renew correctly refuses.
  const renewalAfterPauseSucceeded = await renewLock(redis, key, ownerToken, ttlMs);

  return { ttlMs, pauseMs, lockStolenDuringPause, renewalAfterPauseSucceeded };
}

async function main(): Promise<void> {
  const redis = createRedisClient();
  await waitForRedis(redis);
  try {
    const success = await demonstrateSuccessfulRenewal(redis, "lock:demo:lease-renewal-success", 200, 60, 1_000);
    log.info(success, "heartbeat renewal kept the lease alive for work far longer than a single TTL window");

    const pause = await demonstrateRenewalPauseAllowsTheft(redis, "lock:demo:lease-renewal-pause", 200, 500);
    log.warn(pause, "a renewal pause longer than the TTL still lets a competitor steal the lock - renewal is best-effort");
  } finally {
    redis.disconnect();
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "lease-renewal scenario failed");
    process.exit(1);
  });
}
