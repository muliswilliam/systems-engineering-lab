import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { runConcurrently } from "@labs/test-utils";
import { createSlidingWindowLimiter } from "../../src/rate-limit/sliding-window.js";
import { createTestRedisClient } from "./test-helpers.js";

let redis: Redis;

afterAll(async () => {
  await redis?.quit();
});

/**
 * The exact scenario from the task brief: "120 requests in 1 second against
 * a 100/sec limit -> exactly 100 allowed, 20 rejected." Every check in the
 * burst is issued with the SAME fixed `now`, so all 120 requests are, by
 * construction, inside the identical 1-second window - the assertion is
 * exact regardless of how fast the test runner actually executes the burst.
 */
describe("sliding window rate limiter", () => {
  it("allows exactly `limit` requests and rejects the rest when a burst exceeds the limit inside one window", async () => {
    redis = await createTestRedisClient();
    const clientKey = `test-${randomUUID()}`;
    const limiter = createSlidingWindowLimiter(redis, { windowMs: 1_000, limit: 100 });
    const now = Date.now();

    const results = await runConcurrently(120, () => limiter.check(clientKey, now));
    const allowed = results.filter((r) => r.status === "fulfilled" && r.value.allowed).length;
    const rejected = results.length - allowed;

    expect(allowed).toBe(100);
    expect(rejected).toBe(20);
  });

  it("admits new requests again once old ones fall outside the window", async () => {
    redis = await createTestRedisClient();
    const clientKey = `test-${randomUUID()}`;
    const limiter = createSlidingWindowLimiter(redis, { windowMs: 1_000, limit: 5 });
    const start = Date.now();

    const fill = await runConcurrently(5, () => limiter.check(clientKey, start));
    expect(fill.filter((r) => r.status === "fulfilled" && r.value.allowed).length).toBe(5);

    const stillInsideWindow = await limiter.check(clientKey, start + 500);
    expect(stillInsideWindow.allowed).toBe(false);

    // 1,001ms later, every one of the original 5 entries has aged out of the
    // 1,000ms window, so a fresh request must be admitted again.
    const afterWindowExpires = await limiter.check(clientKey, start + 1_001);
    expect(afterWindowExpires.allowed).toBe(true);
  });
});
