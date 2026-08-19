import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { runConcurrently } from "@labs/test-utils";
import { createTokenBucketLimiter } from "../../src/rate-limit/token-bucket.js";
import { createTestRedisClient } from "./test-helpers.js";

let redis: Redis;

afterAll(async () => {
  await redis?.quit();
});

/**
 * Proves the token bucket rate limiter enforces an EXACT count under real
 * concurrent load, per CLAUDE.md's "assert invariants, not timing" - every
 * check in this burst is issued with the SAME fixed `now`, so refill
 * contributes exactly 0 tokens during the burst regardless of how fast or
 * slow the test machine actually executes it. The exactness comes from the
 * Lua script's atomicity, not from timing luck.
 */
describe("token bucket rate limiter", () => {
  it("allows exactly `capacity` requests and rejects the rest in a burst that exceeds capacity", async () => {
    redis = await createTestRedisClient();
    const clientKey = `test-${randomUUID()}`;
    const limiter = createTokenBucketLimiter(redis, { capacity: 100, refillPerSecond: 100 });
    const now = Date.now();

    const results = await runConcurrently(120, () => limiter.check(clientKey, now));
    const allowed = results.filter((r) => r.status === "fulfilled" && r.value.allowed).length;

    expect(allowed).toBe(100);
    expect(results.length - allowed).toBe(20);
  });

  it("refills tokens deterministically once enough time has passed", async () => {
    redis = await createTestRedisClient();
    const clientKey = `test-${randomUUID()}`;
    const limiter = createTokenBucketLimiter(redis, { capacity: 10, refillPerSecond: 10 });
    const start = Date.now();

    // Drain the bucket completely.
    const drainResults = await runConcurrently(10, () => limiter.check(clientKey, start));
    expect(drainResults.filter((r) => r.status === "fulfilled" && r.value.allowed).length).toBe(10);

    // Immediately after draining, the bucket must be empty.
    const immediateRetry = await limiter.check(clientKey, start);
    expect(immediateRetry.allowed).toBe(false);

    // 500ms later at 10 tokens/sec, exactly 5 tokens should have refilled.
    const afterHalfSecond = await runConcurrently(6, () => limiter.check(clientKey, start + 500));
    const allowedAfterRefill = afterHalfSecond.filter((r) => r.status === "fulfilled" && r.value.allowed).length;
    expect(allowedAfterRefill).toBe(5);
  });
});
