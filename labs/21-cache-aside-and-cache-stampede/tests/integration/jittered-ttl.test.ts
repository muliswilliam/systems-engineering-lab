import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import {
  seedFixedTtlKeys,
  seedJitteredTtlKeys,
  measureExpirationWindow,
  fixedTtlKey,
  jitteredTtlKey,
} from "../../src/cache/jittered-ttl.js";
import { createTestRedisClient } from "./test-helpers.js";

const KEY_COUNT = 150;
const BASE_TTL_MS = 1_200;
const JITTER_FRACTION = 0.2;
const POLL_INTERVAL_MS = 20;
const MAX_WAIT_MS = BASE_TTL_MS * 2;

let redis: Redis;

beforeAll(async () => {
  redis = await createTestRedisClient();
});

afterAll(async () => {
  await redis.quit();
});

describe("jittered TTL vs fixed TTL", () => {
  it("expires jittered-TTL keys across a measurably wider time window than fixed-TTL keys created at the same instant with the same base TTL", async () => {
    await Promise.all([
      seedFixedTtlKeys(redis, KEY_COUNT, BASE_TTL_MS),
      seedJitteredTtlKeys(redis, KEY_COUNT, { baseTtlMs: BASE_TTL_MS, jitterFraction: JITTER_FRACTION }),
    ]);

    const [fixedWindow, jitteredWindow] = await Promise.all([
      measureExpirationWindow(redis, fixedTtlKey, KEY_COUNT, POLL_INTERVAL_MS, MAX_WAIT_MS),
      measureExpirationWindow(redis, jitteredTtlKey, KEY_COUNT, POLL_INTERVAL_MS, MAX_WAIT_MS),
    ]);

    expect(fixedWindow.firstExpiryMs).not.toBeNull();
    expect(fixedWindow.lastExpiryMs).not.toBeNull();
    expect(jitteredWindow.firstExpiryMs).not.toBeNull();
    expect(jitteredWindow.lastExpiryMs).not.toBeNull();

    const fixedSpreadMs = fixedWindow.lastExpiryMs! - fixedWindow.firstExpiryMs!;
    const jitteredSpreadMs = jitteredWindow.lastExpiryMs! - jitteredWindow.firstExpiryMs!;

    // The fixed-TTL set should expire in a narrow window (bounded by poll
    // resolution + Redis's own active-expiry cadence), while the jittered
    // set (+/-20% of a 1200ms base = an ~480ms-wide target window) should be
    // clearly, measurably wider - not just "different by a few ms."
    expect(jitteredSpreadMs).toBeGreaterThan(fixedSpreadMs * 3);
  });
});
