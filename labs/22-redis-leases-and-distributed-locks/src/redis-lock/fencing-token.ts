import "dotenv/config";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import { createLogger } from "@labs/logging";
import { pool, waitForDatabase } from "../db/client.js";
import { createRedisClient, waitForRedis } from "./redis-client.js";
import { acquireLock } from "./basic-lock.js";
import { FENCING_TOKEN_RESOURCE_NAME } from "../seed/scenario-resources.js";
import {
  fencingCounterKeyFor,
  lockKeyFor,
  randomToken,
  readResourceState,
  resetScenarioState,
  sleep,
  writeResourceStateFenced,
  type ResourceStateRow,
} from "./support.js";

const log = createLogger("lab22:redis-lock:fencing-token");

export const FENCING_TOKEN_RESOURCE = FENCING_TOKEN_RESOURCE_NAME;

const LOCK_TTL_MS = 200;
const WORKER_A_WORK_MS = 400;
const WORKER_B_START_DELAY_MS = 250;
const WORKER_B_WORK_MS = 100;

export interface AcquireWithFencingResult {
  acquired: boolean;
  fencingToken: number | null;
}

/**
 * Each successful lock acquisition also atomically increments and returns a
 * fencing token, via `INCR` on a separate counter key done immediately after
 * the lock acquisition. This does NOT prevent the lock from expiring -
 * nothing can force a slow worker to stop - it only guarantees that every
 * successful acquisition (even a "duplicate" one caused by the exact bug in
 * lease-expiry-bug.ts) receives a token strictly greater than every prior
 * acquisition's token, because `INCR` is atomic and monotonic regardless of
 * who calls it or how many "believe" they hold the lock at once.
 */
export async function acquireLockWithFencingToken(
  redis: Redis,
  lockKey: string,
  fencingCounterKey: string,
  ownerToken: string,
  ttlMs: number,
): Promise<AcquireWithFencingResult> {
  const acquired = await acquireLock(redis, lockKey, ownerToken, ttlMs);
  if (!acquired) {
    return { acquired: false, fencingToken: null };
  }
  const fencingToken = await redis.incr(fencingCounterKey);
  return { acquired: true, fencingToken };
}

export interface FencedWorkerRun {
  workerId: "worker-A" | "worker-B";
  lockAcquired: boolean;
  fencingToken: number | null;
  lockAcquiredAtMs: number;
  writeAttemptedAtMs: number;
  writeRowCount: number;
  writeAccepted: boolean;
}

async function workerAFlow(
  pool: Pool,
  redis: Redis,
  lockKey: string,
  fencingCounterKey: string,
  t0: number,
): Promise<FencedWorkerRun> {
  const token = randomToken();
  const { acquired, fencingToken } = await acquireLockWithFencingToken(redis, lockKey, fencingCounterKey, token, LOCK_TTL_MS);
  const lockAcquiredAtMs = Date.now() - t0;
  log.info(
    { workerId: "worker-A", lockAcquired: acquired, fencingToken },
    "worker A acquires the lock and its fencing token, then does work that will outlive the TTL",
  );

  await sleep(WORKER_A_WORK_MS);

  const writeAttemptedAtMs = Date.now() - t0;
  const { rowCount } = await writeResourceStateFenced(pool, FENCING_TOKEN_RESOURCE, "worker-A", fencingToken ?? -1);
  log.info(
    { workerId: "worker-A", fencingToken, writeRowCount: rowCount, writeAttemptedAtMs },
    rowCount === 0
      ? "worker A's late write was REJECTED by the conditional UPDATE - its fencing token is stale, even though A never detected its lock had expired"
      : "worker A's write was accepted",
  );

  return {
    workerId: "worker-A",
    lockAcquired: acquired,
    fencingToken,
    lockAcquiredAtMs,
    writeAttemptedAtMs,
    writeRowCount: rowCount,
    writeAccepted: rowCount > 0,
  };
}

async function workerBFlow(
  pool: Pool,
  redis: Redis,
  lockKey: string,
  fencingCounterKey: string,
  t0: number,
): Promise<FencedWorkerRun> {
  await sleep(WORKER_B_START_DELAY_MS);
  const token = randomToken();
  const { acquired, fencingToken } = await acquireLockWithFencingToken(redis, lockKey, fencingCounterKey, token, LOCK_TTL_MS);
  const lockAcquiredAtMs = Date.now() - t0;
  log.info(
    { workerId: "worker-B", lockAcquired: acquired, fencingToken },
    "worker B acquires the SAME key (A's TTL expired) and gets a HIGHER fencing token",
  );

  await sleep(WORKER_B_WORK_MS);

  const writeAttemptedAtMs = Date.now() - t0;
  const { rowCount } = await writeResourceStateFenced(pool, FENCING_TOKEN_RESOURCE, "worker-B", fencingToken ?? -1);
  log.info(
    { workerId: "worker-B", fencingToken, writeRowCount: rowCount, writeAttemptedAtMs },
    "worker B's write is accepted - its fencing token is the highest one issued so far",
  );

  return {
    workerId: "worker-B",
    lockAcquired: acquired,
    fencingToken,
    lockAcquiredAtMs,
    writeAttemptedAtMs,
    writeRowCount: rowCount,
    writeAccepted: rowCount > 0,
  };
}

export interface FencingTokenResult {
  workerA: FencedWorkerRun;
  workerB: FencedWorkerRun;
  staleWriteRejected: boolean;
  newerWriteAccepted: boolean;
  finalRow: ResourceStateRow;
}

/**
 * Replays the IDENTICAL interleaving as lease-expiry-bug.ts (same TTL, same
 * work durations, same start delay) - the lock still expires under worker A
 * exactly as before, and worker B still acquires the "same" lock while A is
 * still working. The difference is entirely in the write path: fencing
 * tokens mean A's late write, carrying an older token, is rejected
 * (rowCount = 0) by the conditional UPDATE - even though A's own
 * lock-holder logic never found out its lease had expired. The fix protects
 * the DOWNSTREAM resource; it does not (and cannot) stop the lock from
 * expiring.
 */
export async function runFencingTokenFixDemo(pool: Pool, redis: Redis): Promise<FencingTokenResult> {
  await resetScenarioState(pool, redis, FENCING_TOKEN_RESOURCE);
  const lockKey = lockKeyFor(FENCING_TOKEN_RESOURCE);
  const fencingCounterKey = fencingCounterKeyFor(FENCING_TOKEN_RESOURCE);
  const t0 = Date.now();

  const [workerA, workerB] = await Promise.all([
    workerAFlow(pool, redis, lockKey, fencingCounterKey, t0),
    workerBFlow(pool, redis, lockKey, fencingCounterKey, t0),
  ]);

  const finalRow = await readResourceState(pool, FENCING_TOKEN_RESOURCE);

  return {
    workerA,
    workerB,
    staleWriteRejected: !workerA.writeAccepted,
    newerWriteAccepted: workerB.writeAccepted,
    finalRow,
  };
}

async function main(): Promise<void> {
  await waitForDatabase(pool);
  const redis = createRedisClient();
  await waitForRedis(redis);
  try {
    const result = await runFencingTokenFixDemo(pool, redis);
    log.info(
      {
        workerA: result.workerA,
        workerB: result.workerB,
        staleWriteRejected: result.staleWriteRejected,
        newerWriteAccepted: result.newerWriteAccepted,
        finalRow: result.finalRow,
      },
      "fencing-token scenario complete - the stale worker's write never landed",
    );
  } finally {
    redis.disconnect();
    await pool.end();
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "fencing-token scenario failed");
    process.exit(1);
  });
}
