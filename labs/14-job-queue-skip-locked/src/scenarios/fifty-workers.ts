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

const log = createLogger("lab14:scenario:fifty-workers");

const WORKER_COUNT = 50;
const LEASE_MS = 30_000;

/**
 * Same invariant as five-workers.ts, at 10x the contention: 50 concurrent
 * workers hammering `FOR UPDATE SKIP LOCKED` against the same queue. Run
 * this against `pnpm seed --size=large` (250 jobs) so there is enough work
 * for the claim-distribution log to be meaningful - with too few jobs, most
 * workers would claim 0 or 1 and the distribution says nothing.
 *
 * Wall-clock time here is a qualitative "SKIP LOCKED scales" data point
 * (logged, not asserted) - see README.md "Observe" for real captured
 * numbers from this lab's own validation run.
 */
export async function runFiftyWorkersScenario(): Promise<WorkerRunResult[]> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);
  await waitForDatabase(pool);

  const pendingBefore = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(jobs)
    .where(sql`${jobs.status} = 'pending'`);
  log.info({ pendingBefore: pendingBefore[0]?.count ?? 0, workerCount: WORKER_COUNT }, "starting fifty-worker drain");

  const start = Date.now();
  const settled = await runConcurrently(WORKER_COUNT, (index) =>
    runWorkerUntilEmpty(pool, `worker-${index + 1}`, { leaseMs: LEASE_MS, process: processJob }),
  );
  const wallClockMs = Date.now() - start;

  const fulfilledCount = countFulfilled(settled);
  if (fulfilledCount !== WORKER_COUNT) {
    throw new Error(`expected all ${WORKER_COUNT} workers to settle fulfilled, got ${fulfilledCount}`);
  }
  const results = settled.map((r) => (r as PromiseFulfilledResult<WorkerRunResult>).value);

  const claimCounts = results
    .map((r) => ({ workerId: r.workerId, claimed: r.claimedJobIds.length }))
    .sort((a, b) => b.claimed - a.claimed);
  const allClaimedIds = results.flatMap((r) => r.claimedJobIds);
  const uniqueClaimedIds = new Set(allClaimedIds);

  const byStatus = await db
    .select({ status: jobs.status, count: sql<number>`count(*)::int` })
    .from(jobs)
    .groupBy(jobs.status);

  const claimedCountsOnly = claimCounts.map((c) => c.claimed);
  const min = Math.min(...claimedCountsOnly);
  const max = Math.max(...claimedCountsOnly);
  const workersWithZero = claimedCountsOnly.filter((c) => c === 0).length;

  log.info(
    {
      claimCounts,
      totalClaimed: allClaimedIds.length,
      uniqueClaimed: uniqueClaimedIds.size,
      minClaimedByAWorker: min,
      maxClaimedByAWorker: max,
      workersWithZeroClaims: workersWithZero,
      wallClockMs,
      byStatus,
    },
    "fifty-worker scenario complete - SKIP LOCKED distributed jobs across workers without any single worker blocking another",
  );

  if (allClaimedIds.length !== uniqueClaimedIds.size) {
    throw new Error("INVARIANT VIOLATED: at least one job was claimed by more than one worker");
  }

  await pool.end();
  return results;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runFiftyWorkersScenario().catch((error: unknown) => {
    log.error({ err: error }, "fifty-workers scenario failed");
    process.exit(1);
  });
}
