import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Redis } from "ioredis";
import { createRedisClient, waitForRedis } from "../../src/redis-lock/redis-client.js";
import {
  demonstrateLockRace,
  demonstrateUnsafeCheckThenDeleteRace,
  demonstrateWrongOwnerCannotRelease,
} from "../../src/redis-lock/basic-lock.js";

let redis: Redis;

beforeAll(async () => {
  redis = createRedisClient();
  await waitForRedis(redis);
});

afterAll(() => {
  redis.disconnect();
});

describe("SET key value NX PX - two workers racing for the same lock key", () => {
  it("lets exactly one of two concurrent acquire attempts succeed", async () => {
    const result = await demonstrateLockRace(redis, "lock:test:basic-lock-race", 5_000);

    // Exactly one acquired - never both, never neither.
    expect(result.acquiredA !== result.acquiredB).toBe(true);
    expect(result.winner).not.toBe("none");

    // Cleanup.
    await redis.del(result.key);
  });
});

describe("safe release with an atomic Lua check-then-delete", () => {
  it("refuses to release a lock the caller does not own - the key survives with the real owner's token", async () => {
    const result = await demonstrateWrongOwnerCannotRelease(redis, "lock:test:wrong-owner-release", 5_000);

    expect(result.wrongOwnerReleaseSucceeded).toBe(false);
    expect(result.keySurvived).toBe(true);
    expect(result.keyValueAfter).toBe(result.realOwnerToken);

    await redis.del(result.key);
  });
});

describe("the WRONG way: GET then DEL as two separate, non-atomic commands", () => {
  it("really does delete a different owner's lock after the original lock expires and a new owner acquires it", async () => {
    const result = await demonstrateUnsafeCheckThenDeleteRace(redis, "lock:test:unsafe-get-then-del");

    expect(result.acquiredBAfterExpiry).toBe(true);
    // This is the bug being demonstrated, not a desired outcome: A's stale
    // "I already confirmed ownership" naive release logic deletes B's lock.
    expect(result.aDeletedBsLock).toBe(true);
    expect(result.keyValueAfterAsRelease).toBeNull();
  });
});
