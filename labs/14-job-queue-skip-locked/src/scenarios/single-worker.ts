import "dotenv/config";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { drizzle } from "drizzle-orm/node-postgres";
import { jobs } from "../db/schema.js";
import { processJob } from "../queue/process.js";
import { runWorkerUntilEmpty } from "../queue/worker.js";

const log = createLogger("lab14:scenario:single-worker");

const LEASE_MS = 30_000;

/**
 * BASELINE CORRECTNESS CHECK - one worker, no concurrency at all. Every job
 * seeded should end up 'completed', none skipped, none double-processed
 * (trivially true with one worker, but this is the reference point the
 * five/fifty-worker scenarios are compared against).
 */
export async function runSingleWorkerScenario(): Promise<void> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);
  await waitForDatabase(pool);

  const pendingBefore = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(jobs)
    .where(sql`${jobs.status} = 'pending'`);
  log.info({ pendingBefore: pendingBefore[0]?.count ?? 0 }, "starting single-worker drain");

  const start = Date.now();
  const result = await runWorkerUntilEmpty(pool, "worker-1", { leaseMs: LEASE_MS, process: processJob, log });
  const wallClockMs = Date.now() - start;

  const byStatus = await db
    .select({ status: jobs.status, count: sql<number>`count(*)::int` })
    .from(jobs)
    .groupBy(jobs.status);

  log.info(
    {
      workerId: result.workerId,
      claimed: result.claimedJobIds.length,
      completed: result.completedJobIds.length,
      wallClockMs,
      byStatus,
    },
    "single-worker scenario complete",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runSingleWorkerScenario().catch((error: unknown) => {
    log.error({ err: error }, "single-worker scenario failed");
    process.exit(1);
  });
}
