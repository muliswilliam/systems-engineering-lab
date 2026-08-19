import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { runConcurrently } from "@labs/test-utils";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { processJob } from "../../src/queue/process.js";
import { runWorkerUntilEmpty } from "../../src/queue/worker.js";
import { cleanupJobs, insertJobs, resetJobsTable } from "./job-helpers.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await resetJobsTable();
});

afterAll(async () => {
  await pool.end();
});

/**
 * The direct "no double processing" invariant, asserted from the
 * job_attempts audit table itself rather than derived from worker-side
 * results: no two attempts on the SAME job may have overlapping
 * [claimed_at, released_at) windows. If FOR UPDATE SKIP LOCKED ever let two
 * transactions claim the same job at once, this query would find it.
 *
 * An attempt with releasedAt = NULL (still open) is treated as open until
 * "infinity" for the overlap check - none should exist here since every
 * worker in this test runs to completion before the assertion runs.
 */
async function findOverlappingClaimWindows(
  jobIds: number[],
): Promise<{ jobId: number; attemptA: number; attemptB: number }[]> {
  const result = await pool.query<{ job_id: number; attempt_a: number; attempt_b: number }>(
    `SELECT a.job_id, a.id AS attempt_a, b.id AS attempt_b
     FROM job_attempts a
     JOIN job_attempts b
       ON a.job_id = b.job_id AND a.id < b.id
     WHERE a.job_id = ANY($1::bigint[])
       AND a.claimed_at < coalesce(b.released_at, 'infinity'::timestamptz)
       AND b.claimed_at < coalesce(a.released_at, 'infinity'::timestamptz)`,
    [jobIds],
  );
  return result.rows.map((r) => ({ jobId: r.job_id, attemptA: r.attempt_a, attemptB: r.attempt_b }));
}

describe("no two job_attempts rows for the same job ever overlap in time", () => {
  it("holds after 20 concurrent workers race over a 150-job queue", async () => {
    const jobIds = await insertJobs(150, { seed: 2001 });

    await runConcurrently(20, (index) =>
      runWorkerUntilEmpty(pool, `race-worker-${index + 1}`, { leaseMs: 30_000, process: processJob }),
    );

    const overlaps = await findOverlappingClaimWindows(jobIds);
    expect(overlaps).toEqual([]);

    await cleanupJobs(jobIds);
  });
});
