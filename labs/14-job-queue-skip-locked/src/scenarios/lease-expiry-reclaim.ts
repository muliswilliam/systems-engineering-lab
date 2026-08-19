import "dotenv/config";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { jobAttempts, jobs } from "../db/schema.js";
import { claimJob, completeJob } from "../queue/claim.js";
import { processJob } from "../queue/process.js";

const log = createLogger("lab14:scenario:lease-expiry-reclaim");

const SHORT_LEASE_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Simulates a worker that claims a job and then crashes or hangs - it never
 * calls completeJob/failJob, so nothing ever clears jobs.status/locked_by.
 * A short lease (300ms) means we don't have to wait long to prove the queue
 * recovers: once `now() > locked_until`, the claim query's second branch
 * (`status = 'processing' AND locked_until < now()`) makes the job
 * claimable again, and a second worker reclaims and completes it.
 */
export async function runLeaseExpiryReclaimScenario(): Promise<void> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);
  await waitForDatabase(pool);

  const [job] = await db
    .insert(jobs)
    .values({ jobType: "generate_report", payload: { reportId: "scenario-lease-demo" } })
    .returning();
  log.info({ jobId: job!.id, leaseMs: SHORT_LEASE_MS }, "seeded one job for the lease-expiry demo");

  const firstClaim = await claimJob(pool, "worker-crashed", SHORT_LEASE_MS);
  if (!firstClaim || firstClaim.job.id !== job!.id) {
    throw new Error("expected to claim the freshly seeded job");
  }
  log.info(
    { workerId: "worker-crashed", jobId: firstClaim.job.id, lockedUntil: firstClaim.job.lockedUntil },
    "worker-crashed claimed the job, then hangs forever (never calls complete/fail)",
  );

  const immediateReclaim = await claimJob(pool, "worker-eager", SHORT_LEASE_MS);
  const stillLocked = !immediateReclaim || immediateReclaim.job.id !== job!.id;
  log.info(
    { reclaimedImmediately: !stillLocked },
    stillLocked
      ? "confirmed: while the lease is still valid, no other worker can claim this job"
      : "unexpected: another worker claimed the job before its lease expired",
  );
  if (immediateReclaim && immediateReclaim.job.id === job!.id) {
    throw new Error("INVARIANT VIOLATED: job was reclaimed before its lease expired");
  }

  const waitMs = SHORT_LEASE_MS + 200;
  log.info({ waitMs }, "waiting past the lease expiry");
  await sleep(waitMs);

  const start = Date.now();
  const secondClaim = await claimJob(pool, "worker-2", SHORT_LEASE_MS * 100);
  const reclaimLatencyMs = Date.now() - start;
  if (!secondClaim || secondClaim.job.id !== job!.id) {
    throw new Error("INVARIANT VIOLATED: job was not reclaimable after its lease expired");
  }
  log.info(
    { workerId: "worker-2", jobId: secondClaim.job.id, reclaimed: secondClaim.reclaimed, reclaimLatencyMs },
    "worker-2 successfully reclaimed the abandoned job",
  );

  await processJob(secondClaim.job);
  await completeJob(pool, secondClaim.job.id, secondClaim.attemptId);

  const [finalJob] = await db.select().from(jobs).where(eq(jobs.id, job!.id));
  const attempts = await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, job!.id));

  log.info(
    {
      finalStatus: finalJob!.status,
      attempts: finalJob!.attempts,
      attemptRows: attempts.map((a) => ({ workerId: a.workerId, status: a.status })),
    },
    "lease-expiry-reclaim scenario complete - the queue was not permanently stuck by the crashed worker",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runLeaseExpiryReclaimScenario().catch((error: unknown) => {
    log.error({ err: error }, "lease-expiry-reclaim scenario failed");
    process.exit(1);
  });
}
