import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { jobAttempts, jobs } from "../../src/db/schema.js";
import { claimJob, completeJob } from "../../src/queue/claim.js";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SHORT_LEASE_MS = 250;

describe("a job whose lease expires becomes reclaimable and is eventually completed", () => {
  it("is not claimable while the lease is valid, but is claimable and completable once it expires", async () => {
    const jobId = await insertOneJob({ jobType: "generate_report", payload: {} });

    // worker-crashed claims it and never calls complete/fail again - this IS
    // the simulated crash: no code runs after this point for that worker.
    const firstClaim = await claimJob(pool, "worker-crashed", SHORT_LEASE_MS);
    expect(firstClaim?.job.id).toBe(jobId);

    // While the lease is still valid, no other worker can see this job as
    // claimable - it is genuinely 'processing' with a future locked_until,
    // and this test's isolated job batch (just the one job) has nothing
    // else pending.
    const tooEarly = await claimJob(pool, "worker-eager", SHORT_LEASE_MS);
    expect(tooEarly).toBeNull();

    await sleep(SHORT_LEASE_MS + 150);

    // Past the lease, the same claim query's second branch
    // (status = 'processing' AND locked_until < now()) makes it claimable.
    const secondClaim = await claimJob(pool, "worker-2", 30_000);
    expect(secondClaim?.job.id).toBe(jobId);
    expect(secondClaim!.reclaimed).toBe(true);

    await processJob(secondClaim!.job);
    await completeJob(pool, secondClaim!.job.id, secondClaim!.attemptId);

    const [finalJob] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(finalJob!.status).toBe("completed");

    const attempts = await db
      .select()
      .from(jobAttempts)
      .where(eq(jobAttempts.jobId, jobId))
      .orderBy(jobAttempts.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.workerId).toBe("worker-crashed");
    // The crashed worker's own attempt row is marked 'expired', not left
    // dangling at 'claimed' forever - the reclaim transaction closes it out.
    expect(attempts[0]!.status).toBe("expired");
    expect(attempts[1]!.workerId).toBe("worker-2");
    expect(attempts[1]!.status).toBe("completed");

    await cleanupJobs([jobId]);
  });
});
