import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { jobAttempts, jobs } from "../../src/db/schema.js";
import { claimJob, completeJob, failJob } from "../../src/queue/claim.js";
import { processJob } from "../../src/queue/process.js";
import { cleanupJobs, insertOneJob, resetJobsTable } from "./job-helpers.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await resetJobsTable();
});

afterAll(async () => {
  await pool.end();
});

const LEASE_MS = 30_000;

async function claimAndProcessOnce(jobId: number, workerId: string) {
  const claim = await claimJob(pool, workerId, LEASE_MS);
  if (!claim || claim.job.id !== jobId) {
    throw new Error(`expected to claim job ${jobId}, got ${claim?.job.id}`);
  }
  try {
    await processJob(claim.job);
    await completeJob(pool, claim.job.id, claim.attemptId);
    return { terminal: false, succeeded: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result = await failJob(pool, claim.job.id, claim.attemptId, message);
    return { terminal: result.terminal, succeeded: false };
  }
}

describe("retries and terminal failure", () => {
  it("a job that fails past max_attempts ends in status='failed' and is excluded from future claims", async () => {
    const maxAttempts = 3;
    const jobId = await insertOneJob({
      jobType: "process_payment",
      payload: { shouldFail: true },
      maxAttempts,
    });

    let terminal = false;
    let rounds = 0;
    while (!terminal && rounds < maxAttempts + 1) {
      rounds += 1;
      const outcome = await claimAndProcessOnce(jobId, `retry-worker-${rounds}`);
      expect(outcome.succeeded).toBe(false);
      terminal = outcome.terminal;
    }

    expect(rounds).toBe(maxAttempts);
    expect(terminal).toBe(true);

    const [finalJob] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(finalJob!.status).toBe("failed");
    expect(finalJob!.attempts).toBe(maxAttempts);

    const attempts = await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, jobId));
    expect(attempts).toHaveLength(maxAttempts);
    expect(attempts.every((a) => a.status === "failed")).toBe(true);

    // The terminal invariant: the claim query must never select this job
    // again, regardless of how many workers ask. This test's isolated job
    // (the only one it inserted) is now 'failed', so nothing else should be
    // claimable at all.
    const reclaim = await claimJob(pool, "retry-worker-after-terminal", LEASE_MS);
    expect(reclaim).toBeNull();

    await cleanupJobs([jobId]);
  });

  it("a job that succeeds before max_attempts is completed and its attempt count reflects how many tries it took", async () => {
    // maxAttempts high enough that the job never goes terminal; the payload
    // does not set shouldFail, so the very first attempt succeeds.
    const jobId = await insertOneJob({ jobType: "send_email", payload: {}, maxAttempts: 5 });

    const outcome = await claimAndProcessOnce(jobId, "single-try-worker");
    expect(outcome.succeeded).toBe(true);

    const [finalJob] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(finalJob!.status).toBe("completed");
    expect(finalJob!.attempts).toBe(1);

    const attempts = await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, jobId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("completed");

    await cleanupJobs([jobId]);
  });
});
