import "dotenv/config";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { countFulfilled, runConcurrently } from "@labs/test-utils";
import { jobs } from "../db/schema.js";
import { processJob } from "../queue/process.js";
import { runWorkerUntilEmpty, type WorkerRunResult } from "../queue/worker.js";

const log = createLogger("lab14:scenario:five-workers");

const WORKER_COUNT = 5;
const LEASE_MS = 30_000;

/**
 * 5 concurrent workers draining one shared queue. The invariant under test:
 * every job is claimed by exactly one worker (no job_id appears in more than
 * one worker's claimedJobIds), and the union of every worker's completed
 * jobs equals every job that was pending at the start - the whole queue
 * drains with nothing skipped and nothing double-processed.
 */
export async function runFiveWorkersScenario(): Promise<WorkerRunResult[]> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);
  await waitForDatabase(pool);

  const pendingBefore = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(jobs)
    .where(sql`${jobs.status} = 'pending'`);
  log.info({ pendingBefore: pendingBefore[0]?.count ?? 0, workerCount: WORKER_COUNT }, "starting five-worker drain");

  const start = Date.now();
  const settled = await runConcurrently(WORKER_COUNT, (index) =>
    runWorkerUntilEmpty(pool, `worker-${index + 1}`, { leaseMs: LEASE_MS, process: processJob, log }),
  );
  const wallClockMs = Date.now() - start;

  const fulfilledCount = countFulfilled(settled);
  if (fulfilledCount !== WORKER_COUNT) {
    throw new Error(`expected all ${WORKER_COUNT} workers to settle fulfilled, got ${fulfilledCount}`);
  }
  const results = settled.map((r) => (r as PromiseFulfilledResult<WorkerRunResult>).value);

  const claimCounts = results.map((r) => ({ workerId: r.workerId, claimed: r.claimedJobIds.length }));
  const allClaimedIds = results.flatMap((r) => r.claimedJobIds);
  const uniqueClaimedIds = new Set(allClaimedIds);

  const byStatus = await db
    .select({ status: jobs.status, count: sql<number>`count(*)::int` })
    .from(jobs)
    .groupBy(jobs.status);

  log.info(
    {
      claimCounts,
      totalClaimed: allClaimedIds.length,
      uniqueClaimed: uniqueClaimedIds.size,
      wallClockMs,
      byStatus,
    },
    "five-worker scenario complete",
  );

  if (allClaimedIds.length !== uniqueClaimedIds.size) {
    throw new Error("INVARIANT VIOLATED: at least one job was claimed by more than one worker");
  }

  await pool.end();
  return results;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runFiveWorkersScenario().catch((error: unknown) => {
    log.error({ err: error }, "five-workers scenario failed");
    process.exit(1);
  });
}
