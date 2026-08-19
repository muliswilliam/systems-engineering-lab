import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { runConcurrently } from "@labs/test-utils";
import { enqueue, resetQueueState, runBoundedQueueWorker } from "../backpressure/bounded-queue.js";
import { sleep } from "../downstream/slow-downstream.js";

const log = createLogger("lab36:scenario:backpressure-bounded");

const CAPACITY = 20;
const PHASE1_BURST_SIZE = 200;
const WORKER_WORK_MS = 30;
const PHASE2_DURATION_MS = 2_000;

/**
 * The backpressure fix, in two phases against the SAME real, bounded,
 * Postgres-backed queue capacity mechanism (src/backpressure/bounded-queue.ts):
 *
 * Phase 1 proves the hard bound: 200 concurrent enqueue attempts against an
 * empty, capacity-20 queue with NO worker draining it yet should admit
 * exactly 20 and reject exactly 180 - immediately, not eventually.
 *
 * Phase 2 proves the bound holds under sustained pressure, not just for one
 * instantaneous burst: a worker drains the queue while a producer keeps
 * submitting far faster than the worker can keep up, for a fixed duration.
 * `pending_count` (polled repeatedly throughout) must never exceed CAPACITY
 * even once, and the queue must keep accepting SOME new work as the worker
 * frees up slots - contrasted with the naive scenario's unbounded, ever
 * growing backlog.
 */
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL not set - copy .env.example to .env first");
  }
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  await resetQueueState(pool, CAPACITY);

  log.info({ capacity: CAPACITY, burstSize: PHASE1_BURST_SIZE }, "Phase 1: saturating an idle queue");

  const phase1Results = await runConcurrently(PHASE1_BURST_SIZE, () => enqueue(pool));
  const phase1Accepted = phase1Results.filter((r) => r.status === "fulfilled" && r.value.accepted).length;
  const phase1Rejected = phase1Results.length - phase1Accepted;

  log.warn(
    { burstSize: PHASE1_BURST_SIZE, capacity: CAPACITY, accepted: phase1Accepted, rejected: phase1Rejected },
    phase1Accepted === CAPACITY
      ? "BACKPRESSURE ENFORCED EXACTLY: accepted count matches queue capacity, no more, no less"
      : "unexpected: accepted count did not exactly match capacity",
  );

  log.info(
    { capacity: CAPACITY, workerWorkMs: WORKER_WORK_MS, durationMs: PHASE2_DURATION_MS },
    "Phase 2: draining with one worker while a producer keeps submitting faster than it can keep up",
  );

  let stopWorker = false;
  const workerPromise = runBoundedQueueWorker(pool, "worker-1", WORKER_WORK_MS, () => stopWorker);

  const pendingCountSamples: number[] = [];
  let sampleInFlight = false;
  const samplePoll = setInterval(() => {
    // Guard against overlapping ticks: if a sample query is already
    // in-flight (e.g. the pool is briefly busy), skip this tick instead of
    // piling up more concurrent queries on top of it.
    if (sampleInFlight) return;
    sampleInFlight = true;
    pool
      .query<{ pending_count: number }>("SELECT pending_count FROM queue_state WHERE id = 1")
      .then((res) => {
        const value = res.rows[0]?.pending_count;
        if (value !== undefined) pendingCountSamples.push(value);
      })
      .catch(() => {})
      .finally(() => {
        sampleInFlight = false;
      });
  }, 25);

  let phase2Accepted = 0;
  let phase2Rejected = 0;
  const phase2Start = Date.now();
  while (Date.now() - phase2Start < PHASE2_DURATION_MS) {
    const result = await enqueue(pool);
    if (result.accepted) {
      phase2Accepted += 1;
    } else {
      phase2Rejected += 1;
    }
  }

  clearInterval(samplePoll);
  stopWorker = true;
  const processedByWorker = await workerPromise;

  const maxObservedPending = pendingCountSamples.length > 0 ? Math.max(...pendingCountSamples) : 0;

  log.warn(
    {
      durationMs: PHASE2_DURATION_MS,
      capacity: CAPACITY,
      phase2Accepted,
      phase2Rejected,
      processedByWorker,
      maxObservedPendingCount: maxObservedPending,
      pendingCountSampleCount: pendingCountSamples.length,
    },
    maxObservedPending <= CAPACITY
      ? "INVARIANT HELD under sustained pressure: pending_count never exceeded capacity across every sample taken"
      : "INVARIANT VIOLATED: pending_count exceeded capacity at least once - this should never happen",
  );

  await sleep(50);
  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "bounded backpressure scenario failed");
    process.exit(1);
  });
}
