import "dotenv/config";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import { createLogger } from "@labs/logging";
import { pool, waitForDatabase } from "../db/client.js";
import { createRedisClient, waitForRedis } from "./redis-client.js";
import { acquireLock } from "./basic-lock.js";
import { LEASE_EXPIRY_RESOURCE_NAME } from "../seed/scenario-resources.js";
import {
  lockKeyFor,
  randomToken,
  readResourceState,
  resetScenarioState,
  sleep,
  writeResourceStateNaive,
  type ResourceStateRow,
} from "./support.js";

const log = createLogger("lab22:redis-lock:lease-expiry-bug");

export const LEASE_EXPIRY_RESOURCE = LEASE_EXPIRY_RESOURCE_NAME;

// Short enough that worker A's "work" genuinely outlives it without any
// mocking or fake clocks - this is a real TTL expiring in a real Redis.
const LOCK_TTL_MS = 200;
// Longer than the TTL on purpose: this is the bug. A never renews.
const WORKER_A_WORK_MS = 400;
// B starts checking well after A's lease is guaranteed to have expired
// (LOCK_TTL_MS < WORKER_B_START_DELAY_MS < WORKER_A_WORK_MS), so B's
// acquisition genuinely happens while A is still in the middle of "working".
const WORKER_B_START_DELAY_MS = 250;
const WORKER_B_WORK_MS = 100;

export interface WorkerRun {
  workerId: "worker-A" | "worker-B";
  lockAcquired: boolean;
  lockAcquiredAtMs: number;
  workStartedAtMs: number;
  workEndedAtMs: number;
  writeAttemptedAtMs: number;
  writeRowCount: number;
}

export interface LeaseExpiryBugResult {
  workerA: WorkerRun;
  workerB: WorkerRun;
  bothBelievedTheyHeldTheLockAtTheSameTime: boolean;
  finalRow: ResourceStateRow;
}

async function workerAFlow(pool: Pool, redis: Redis, lockKey: string, t0: number): Promise<WorkerRun> {
  const token = randomToken();
  const lockAcquired = await acquireLock(redis, lockKey, token, LOCK_TTL_MS);
  const lockAcquiredAtMs = Date.now() - t0;
  log.info(
    { workerId: "worker-A", lockAcquired, ttlMs: LOCK_TTL_MS, workMs: WORKER_A_WORK_MS },
    "worker A acquired the lock with a short TTL, about to do work that outlives it - it will NOT renew",
  );

  const workStartedAtMs = Date.now() - t0;
  await sleep(WORKER_A_WORK_MS);
  const workEndedAtMs = Date.now() - t0;

  // Worker A never re-checked Redis. It still believes it holds the lock
  // purely because it never received an error - this is the bug: nothing
  // tells a lease holder its lease has expired.
  const writeAttemptedAtMs = Date.now() - t0;
  const { rowCount } = await writeResourceStateNaive(pool, LEASE_EXPIRY_RESOURCE, "worker-A");
  log.warn(
    { workerId: "worker-A", writeRowCount: rowCount, writeAttemptedAtMs },
    "worker A writes to resource_state, still believing it exclusively holds the lock",
  );

  return { workerId: "worker-A", lockAcquired, lockAcquiredAtMs, workStartedAtMs, workEndedAtMs, writeAttemptedAtMs, writeRowCount: rowCount };
}

async function workerBFlow(pool: Pool, redis: Redis, lockKey: string, t0: number): Promise<WorkerRun> {
  await sleep(WORKER_B_START_DELAY_MS);
  const token = randomToken();
  const lockAcquired = await acquireLock(redis, lockKey, token, LOCK_TTL_MS);
  const lockAcquiredAtMs = Date.now() - t0;
  log.info(
    { workerId: "worker-B", lockAcquired, delayMs: WORKER_B_START_DELAY_MS },
    "worker B checks the SAME key after A's TTL has elapsed and successfully acquires it - A's lock silently expired",
  );

  const workStartedAtMs = Date.now() - t0;
  await sleep(WORKER_B_WORK_MS);
  const workEndedAtMs = Date.now() - t0;

  const writeAttemptedAtMs = Date.now() - t0;
  const { rowCount } = await writeResourceStateNaive(pool, LEASE_EXPIRY_RESOURCE, "worker-B");
  log.warn(
    { workerId: "worker-B", writeRowCount: rowCount, writeAttemptedAtMs },
    "worker B writes to resource_state, also believing it exclusively holds the lock",
  );

  return { workerId: "worker-B", lockAcquired, lockAcquiredAtMs, workStartedAtMs, workEndedAtMs, writeAttemptedAtMs, writeRowCount: rowCount };
}

/**
 * THE central demonstration of this lab: a lock with a TTL shorter than the
 * work it's meant to protect expires while the holder is still working, a
 * second worker acquires the "same" lock, and BOTH workers end up believing
 * they exclusively hold it and both write to resource_state - overlapping in
 * real wall-clock time, with no error raised anywhere. This is not
 * simulated: LOCK_TTL_MS really elapses in Redis, worker B's `SET NX`
 * really succeeds because the key is really gone, and both writes are real
 * Postgres UPDATEs that both really succeed.
 */
export async function runLeaseExpiryBugDemo(pool: Pool, redis: Redis): Promise<LeaseExpiryBugResult> {
  await resetScenarioState(pool, redis, LEASE_EXPIRY_RESOURCE);
  const lockKey = lockKeyFor(LEASE_EXPIRY_RESOURCE);
  const t0 = Date.now();

  const [workerA, workerB] = await Promise.all([
    workerAFlow(pool, redis, lockKey, t0),
    workerBFlow(pool, redis, lockKey, t0),
  ]);

  const finalRow = await readResourceState(pool, LEASE_EXPIRY_RESOURCE);

  // The real, provable overlap: B acquired its lock while A's "work" window
  // (acquire -> write) was still open. Both genuinely believed, at the same
  // moment in wall-clock time, that they alone held the lock.
  const bothBelievedTheyHeldTheLockAtTheSameTime =
    workerA.lockAcquired &&
    workerB.lockAcquired &&
    workerB.lockAcquiredAtMs < workerA.writeAttemptedAtMs &&
    workerA.lockAcquiredAtMs < workerB.writeAttemptedAtMs;

  return { workerA, workerB, bothBelievedTheyHeldTheLockAtTheSameTime, finalRow };
}

async function main(): Promise<void> {
  await waitForDatabase(pool);
  const redis = createRedisClient();
  await waitForRedis(redis);
  try {
    const result = await runLeaseExpiryBugDemo(pool, redis);
    log.error(
      {
        workerA: result.workerA,
        workerB: result.workerB,
        bothBelievedTheyHeldTheLockAtTheSameTime: result.bothBelievedTheyHeldTheLockAtTheSameTime,
        finalRow: result.finalRow,
      },
      "lease-expiry-bug scenario complete - two workers double-wrote resource_state with no error raised anywhere",
    );
  } finally {
    redis.disconnect();
    await pool.end();
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "lease-expiry-bug scenario failed");
    process.exit(1);
  });
}
