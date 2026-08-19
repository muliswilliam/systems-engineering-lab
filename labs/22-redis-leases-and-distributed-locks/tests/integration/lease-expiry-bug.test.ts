import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Redis } from "ioredis";
import { pool, waitForDatabase, db } from "../../src/db/client.js";
import { createRedisClient, waitForRedis } from "../../src/redis-lock/redis-client.js";
import { runLeaseExpiryBugDemo } from "../../src/redis-lock/lease-expiry-bug.js";
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

describe("a lease shorter than the work it protects expires while the holder is still working", () => {
  it("really produces two workers who both believe they hold the lock and both write to resource_state, with overlapping wall-clock windows", async () => {
    const result = await runLeaseExpiryBugDemo(pool, redis);

    // Both workers' SET NX PX genuinely succeeded - Redis really handed the
    // "same" lock out twice, once per real TTL expiry.
    expect(result.workerA.lockAcquired).toBe(true);
    expect(result.workerB.lockAcquired).toBe(true);

    // The real proof of overlap: worker B acquired its lock (believing
    // itself the exclusive holder) before worker A's own write - i.e. while
    // A's "critical section" was still open in wall-clock time.
    expect(result.bothBelievedTheyHeldTheLockAtTheSameTime).toBe(true);
    expect(result.workerB.lockAcquiredAtMs).toBeLessThan(result.workerA.writeAttemptedAtMs);

    // Both writes succeeded - no error raised anywhere, a silent
    // correctness bug rather than a crash.
    expect(result.workerA.writeRowCount).toBe(1);
    expect(result.workerB.writeRowCount).toBe(1);

    // The final row reflects whichever worker's write landed last in real
    // time - not necessarily the "logical" owner.
    const lastWriter = result.workerA.writeAttemptedAtMs > result.workerB.writeAttemptedAtMs ? "worker-A" : "worker-B";
    expect(result.finalRow.lastWriter).toBe(lastWriter);
  });
});
