import { inArray } from "drizzle-orm";
import { generateJobs } from "@labs/data-generators";
import { db } from "../../src/db/client.js";
import { jobAttempts, jobs } from "../../src/db/schema.js";

/**
 * Each test in this lab inserts its own small, isolated batch of jobs -
 * same pattern as Lab 05's account-helpers.ts - so concurrency invariants
 * ("every job ends up completed exactly once") can be asserted against a
 * known, test-owned set of ids instead of whatever pnpm seed left behind.
 */
export async function insertJobs(
  count: number,
  opts: { seed?: number; failureRate?: number; maxAttempts?: number } = {},
): Promise<number[]> {
  const generated = generateJobs(count, opts.seed ?? Date.now(), opts.failureRate ?? 0);
  const inserted = await db
    .insert(jobs)
    .values(
      generated.map((j) => ({
        jobType: j.jobType,
        payload: j.payload,
        maxAttempts: opts.maxAttempts ?? 5,
      })),
    )
    .returning({ id: jobs.id });
  return inserted.map((r) => r.id);
}

export async function insertOneJob(opts: {
  jobType?: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
}): Promise<number> {
  const [row] = await db
    .insert(jobs)
    .values({
      jobType: opts.jobType ?? "send_email",
      payload: opts.payload ?? {},
      maxAttempts: opts.maxAttempts ?? 5,
    })
    .returning({ id: jobs.id });
  return row!.id;
}

export async function cleanupJobs(jobIds: number[]): Promise<void> {
  if (jobIds.length === 0) return;
  await db.delete(jobAttempts).where(inArray(jobAttempts.jobId, jobIds));
  await db.delete(jobs).where(inArray(jobs.id, jobIds));
}

/**
 * Every test in this lab inserts its own isolated job batch and asserts
 * against a worker draining the queue "until empty" - which, by design,
 * claims from the WHOLE `jobs` table, not just the ids a given test
 * inserted (that generality is the point: a real worker doesn't know which
 * jobs "belong" to which test). That means any pending row left over from a
 * previous `pnpm seed` run would get scooped up by these tests too,
 * breaking their exact-count assertions. Call this once per test file's
 * `beforeAll` (after migrating) so the suite starts from a genuinely empty
 * queue regardless of what `pnpm seed` last left behind - this mirrors the
 * repo's Definition of Done chaining `db:migrate` -> `seed` -> `test`.
 */
export async function resetJobsTable(): Promise<void> {
  await db.delete(jobAttempts);
  await db.delete(jobs);
}
