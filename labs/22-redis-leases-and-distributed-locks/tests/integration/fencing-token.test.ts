import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Redis } from "ioredis";
import { pool, waitForDatabase, db } from "../../src/db/client.js";
import { createRedisClient, waitForRedis } from "../../src/redis-lock/redis-client.js";
import { runFencingTokenFixDemo } from "../../src/redis-lock/fencing-token.js";
import { ensureScenarioResources } from "../../src/seed/ensure-scenario-resources.js";

let redis: Redis;

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await ensureScenarioResources();
  redis = createRedisClient();
  await waitForRedis(redis);
});

afterAll(async () => {
  redis.disconnect();
  await pool.end();
});

describe("fencing tokens defend the downstream write even when the lock-expiry bug still happens", () => {
  it("rejects the stale worker's late write (rowCount=0) while the newer worker's higher-token write succeeds", async () => {
    const result = await runFencingTokenFixDemo(pool, redis);

    // The lock-expiry bug still happens exactly as in lease-expiry-bug.ts -
    // fencing tokens do not (and cannot) stop the lock from expiring.
    expect(result.workerA.lockAcquired).toBe(true);
    expect(result.workerB.lockAcquired).toBe(true);

    // B's fencing token must be strictly greater than A's - INCR is
    // monotonic regardless of how many callers believe they hold the lock.
    expect(result.workerA.fencingToken).not.toBeNull();
    expect(result.workerB.fencingToken).not.toBeNull();
    expect(result.workerB.fencingToken!).toBeGreaterThan(result.workerA.fencingToken!);

    // The stale worker's write is rejected outright - rowCount 0, not an
    // error, not a corrupted row - even though worker A's own lock-holder
    // logic never detected that its lease had expired.
    expect(result.workerA.writeRowCount).toBe(0);
    expect(result.staleWriteRejected).toBe(true);

    // The newer worker's write, carrying the higher token, succeeds.
    expect(result.workerB.writeRowCount).toBe(1);
    expect(result.newerWriteAccepted).toBe(true);

    // The row's persisted fencing_token matches the accepted (higher) token,
    // and last_writer reflects the worker whose write actually landed.
    expect(result.finalRow.fencingToken).toBe(result.workerB.fencingToken);
    expect(result.finalRow.lastWriter).toBe("worker-B");
  });
});
