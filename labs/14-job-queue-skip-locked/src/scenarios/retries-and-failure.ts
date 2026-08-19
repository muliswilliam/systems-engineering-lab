import "dotenv/config";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { jobAttempts, jobs } from "../db/schema.js";
import { claimJob, completeJob, failJob } from "../queue/claim.js";
import { processJob } from "../queue/process.js";

const log = createLogger("lab14:scenario:retries-and-failure");

const LEASE_MS = 30_000;
const MAX_ATTEMPTS = 3;

/**
 * Inserts one dedicated job whose payload always throws (payload.shouldFail
 * = true), independent of whatever pnpm seed left in the table - this
 * scenario is self-contained on purpose (same pattern as Lab 05's
 * account-helpers.ts). A single worker claims it repeatedly: each claim
 * increments jobs.attempts and appends one job_attempts row; the job goes
 * back to 'pending' after each failed attempt until attempts reaches
 * max_attempts, at which point it moves to the terminal 'failed' status and
 * the claim query never selects it again.
 */
export async function runRetriesAndFailureScenario(): Promise<void> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);
  await waitForDatabase(pool);

  const [job] = await db
    .insert(jobs)
    .values({
      jobType: "process_payment",
      payload: { shouldFail: true, orderId: "scenario-retries-demo" },
      maxAttempts: MAX_ATTEMPTS,
    })
    .returning();
  log.info({ jobId: job!.id, maxAttempts: MAX_ATTEMPTS }, "seeded one always-failing job");

  let round = 0;
  for (;;) {
    round += 1;
    const claim = await claimJob(pool, "worker-retry-demo", LEASE_MS);
    if (!claim || claim.job.id !== job!.id) {
      log.info({ round }, "job no longer claimable - it has reached a terminal state");
      break;
    }

    try {
      await processJob(claim.job);
      await completeJob(pool, claim.job.id, claim.attemptId);
      log.info({ round, jobId: claim.job.id }, "unexpectedly succeeded");
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failResult = await failJob(pool, claim.job.id, claim.attemptId, message);
      log.warn(
        { round, jobId: claim.job.id, attempt: failResult.attempts, maxAttempts: failResult.maxAttempts, terminal: failResult.terminal },
        failResult.terminal ? "reached max attempts - job is now terminally failed" : "attempt failed - job returned to pending for retry",
      );
      if (failResult.terminal) {
        break;
      }
    }
  }

  const [finalJob] = await db.select().from(jobs).where(eq(jobs.id, job!.id));
  const attempts = await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, job!.id));

  log.info(
    {
      finalStatus: finalJob!.status,
      attempts: finalJob!.attempts,
      maxAttempts: finalJob!.maxAttempts,
      attemptRows: attempts.map((a) => ({ attemptNumber: a.attemptNumber, status: a.status })),
    },
    "retries-and-failure scenario complete",
  );

  // Confirm the terminal job is truly excluded from future claims.
  const reclaim = await claimJob(pool, "worker-retry-demo-2", LEASE_MS);
  if (reclaim && reclaim.job.id === job!.id) {
    throw new Error("INVARIANT VIOLATED: a terminally failed job was claimed again");
  }
  if (reclaim) {
    // Some other pending job from a shared seed happened to be claimable -
    // release it immediately so this scenario doesn't leave stray state.
    await failJob(pool, reclaim.job.id, reclaim.attemptId, "released by retries-and-failure scenario cleanup");
  }
  log.info({ jobId: job!.id }, "confirmed: terminally failed job is never claimed again");

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runRetriesAndFailureScenario().catch((error: unknown) => {
    log.error({ err: error }, "retries-and-failure scenario failed");
    process.exit(1);
  });
}
