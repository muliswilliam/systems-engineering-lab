import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { countFulfilled, runConcurrently } from "@labs/test-utils";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { jobs } from "../../src/db/schema.js";
import { processJob } from "../../src/queue/process.js";
import { runWorkerUntilEmpty, type WorkerRunResult } from "../../src/queue/worker.js";
import { cleanupJobs, insertJobs, resetJobsTable } from "./job-helpers.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await resetJobsTable();
});

afterAll(async () => {
  await pool.end();
});

const LEASE_MS = 30_000;

async function drain(workerCount: number, jobIds: number[]): Promise<WorkerRunResult[]> {
  const settled = await runConcurrently(workerCount, (index) =>
    runWorkerUntilEmpty(pool, `test-worker-${index + 1}`, { leaseMs: LEASE_MS, process: processJob }),
  );
  expect(countFulfilled(settled)).toBe(workerCount);
  return settled.map((r) => (r as PromiseFulfilledResult<WorkerRunResult>).value);
}

/**
 * The core invariant per SPEC.md section 11 / CLAUDE.md's example ("100
 * concurrent seat reservation attempts -> exactly 1 successful reservation").
 * This lab's equivalent: N concurrent workers draining a queue of M jobs ->
 * every job ends up 'completed' exactly once, and the completed count equals
 * M. Assertions are on final database state and claim-id sets, never on
 * which worker got which job or on execution order.
 */
describe("N concurrent workers draining a shared queue", () => {
  it("1 worker: every job of a 10-job batch ends up completed exactly once", async () => {
    const jobIds = await insertJobs(10, { seed: 1001 });
    const [result] = await drain(1, jobIds);

    // Numeric sort - the default Array.prototype.sort() is lexicographic and
    // would misorder ids past 9 (e.g. 10 before 9), producing a false
    // mismatch even when the id *sets* are actually identical.
    const numericSort = (a: number, b: number) => a - b;
    expect(result!.completedJobIds.slice().sort(numericSort)).toEqual([...jobIds].sort(numericSort));

    const rows = await db.select().from(jobs).where(inArray(jobs.id, jobIds));
    expect(rows.every((r) => r.status === "completed")).toBe(true);
    expect(rows.every((r) => r.attempts === 1)).toBe(true);

    await cleanupJobs(jobIds);
  });

  it("5 workers: every job of a 40-job batch is claimed by exactly one worker, all complete", async () => {
    const jobIds = await insertJobs(40, { seed: 1005 });
    const results = await drain(5, jobIds);

    const allClaimed = results.flatMap((r) => r.claimedJobIds);
    const uniqueClaimed = new Set(allClaimed);
    // No job appears twice across every worker's claimed list combined -
    // this is the real "no double processing" invariant, derived from the
    // actual claim results, not from timing or worker ordering.
    expect(allClaimed.length).toBe(uniqueClaimed.size);
    expect(uniqueClaimed.size).toBe(jobIds.length);

    const completedCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(jobs)
      .where(inArray(jobs.id, jobIds));
    const rows = await db.select().from(jobs).where(inArray(jobs.id, jobIds));
    expect(rows.every((r) => r.status === "completed")).toBe(true);
    expect(completedCount[0]!.count).toBe(jobIds.length);

    await cleanupJobs(jobIds);
  });

  it("50 workers: every job of a 200-job batch is claimed by exactly one worker, all complete", async () => {
    const jobIds = await insertJobs(200, { seed: 1050 });
    const start = Date.now();
    const results = await drain(50, jobIds);
    const wallClockMs = Date.now() - start;

    const allClaimed = results.flatMap((r) => r.claimedJobIds);
    const uniqueClaimed = new Set(allClaimed);
    expect(allClaimed.length).toBe(uniqueClaimed.size);
    expect(uniqueClaimed.size).toBe(jobIds.length);

    const rows = await db.select().from(jobs).where(inArray(jobs.id, jobIds));
    expect(rows.every((r) => r.status === "completed")).toBe(true);
    expect(rows.every((r) => r.attempts === 1)).toBe(true);

    // Not an assertion (timing is not an invariant per SPEC.md section 11) -
    // logged so `pnpm test` output captures a real number for the README.
    // eslint-disable-next-line no-console
    console.log(`[50-worker test] wall clock: ${wallClockMs}ms, jobs: ${jobIds.length}`);

    await cleanupJobs(jobIds);
  });
});
