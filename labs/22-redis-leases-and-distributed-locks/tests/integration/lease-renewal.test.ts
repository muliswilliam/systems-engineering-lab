import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Redis } from "ioredis";
import { createRedisClient, waitForRedis } from "../../src/redis-lock/redis-client.js";
import {
  demonstrateRenewalPauseAllowsTheft,
  demonstrateSuccessfulRenewal,
} from "../../src/redis-lock/lease-renewal.js";

let redis: Redis;

beforeAll(async () => {
  redis = createRedisClient();
  await waitForRedis(redis);
});

afterAll(() => {
  redis.disconnect();
});

describe("heartbeat lease renewal", () => {
  it("keeps a lease held across work that far outlives a single TTL window, with no competitor able to steal it", async () => {
    const result = await demonstrateSuccessfulRenewal(redis, "lock:test:lease-renewal-success", 200, 60, 1_000);

    expect(result.renewalCount).toBeGreaterThan(0);
    expect(result.lockHeldThroughout).toBe(true);
    expect(result.competitorAcquiredDuringWork).toBe(false);
  });

  it("cannot survive a pause longer than the TTL - a competitor acquires, and the paused holder's later renewal correctly fails", async () => {
    const result = await demonstrateRenewalPauseAllowsTheft(redis, "lock:test:lease-renewal-pause", 200, 500);

    expect(result.lockStolenDuringPause).toBe(true);
    expect(result.renewalAfterPauseSucceeded).toBe(false);
  });
});
