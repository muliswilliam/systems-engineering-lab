import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { claimJob } from "../../src/queue/claim.js";
import { claimJobPlainForUpdate } from "../../src/queue/naive-claim.js";
import { cleanupJobs, insertJobs, resetJobsTable } from "./job-helpers.js";

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

/**
 * The "Break it" / "Fix it" contrast for this lab's README: plain
 * `FOR UPDATE` (no SKIP LOCKED) makes a second worker queue up behind the
 * first worker's held lock on the SAME candidate row, even though other
 * unlocked pending rows exist. `FOR UPDATE SKIP LOCKED` lets the second
 * worker move on immediately and claim a different row instead.
 */
describe("FOR UPDATE (no SKIP LOCKED) serializes workers behind the same row; SKIP LOCKED does not", () => {
  it("plain FOR UPDATE: a second worker blocks until the first worker's transaction ends, even with other jobs free", async () => {
    const jobIds = await insertJobs(5, { seed: 3001 });

    const holder = await pool.connect();
    await holder.query("BEGIN");
    // Manually replicate claimJobPlainForUpdate's SELECT on the holder
    // connection so the transaction (and its row lock) stays open while a
    // second, independent connection tries to claim.
    const held = await holder.query<{ id: number }>(
      `SELECT id FROM jobs WHERE status = 'pending' ORDER BY created_at FOR UPDATE LIMIT 1`,
    );
    expect(held.rows[0]?.id).toBeDefined();

    const blockedCallStart = Date.now();
    const blockedCallPromise = claimJobPlainForUpdate(pool, "naive-worker-2");

    // Give the second call time to actually block on the lock before we
    // release it - this is what makes the wait measurable rather than
    // racing the release.
    await sleep(300);
    await holder.query("COMMIT");
    holder.release();

    const secondResult = await blockedCallPromise;
    const totalWaitMs = Date.now() - blockedCallStart;

    // eslint-disable-next-line no-console
    console.log(`[plain FOR UPDATE test] second claim blocked for ${totalWaitMs}ms`);

    // The second worker's SELECT ... FOR UPDATE genuinely blocked for
    // roughly the 300ms the first transaction held the lock - it did not
    // move on to a different, unlocked pending row in the meantime.
    expect(totalWaitMs).toBeGreaterThanOrEqual(250);
    // Once unblocked, the row it was waiting on had already been claimed
    // (status is no longer 'pending') by nothing else in this test, so the
    // naive claim's own SELECT resolves to the SAME row id that was held -
    // it never even looked at another row while blocked.
    expect(secondResult?.jobId).toBe(held.rows[0]!.id);

    await cleanupJobs(jobIds);
  });

  it("FOR UPDATE SKIP LOCKED: a second worker claims a DIFFERENT row immediately instead of blocking", async () => {
    const jobIds = await insertJobs(5, { seed: 3002 });

    const holder = await pool.connect();
    await holder.query("BEGIN");
    const held = await holder.query<{ id: number }>(
      `SELECT id FROM jobs WHERE status = 'pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    expect(held.rows[0]?.id).toBeDefined();

    const start = Date.now();
    const secondClaim = await claimJob(pool, "skip-locked-worker-2", 30_000);
    const elapsedMs = Date.now() - start;

    // Not an assertion (timing is not an invariant) - logged so `pnpm test`
    // output captures a real number for the README's Break it/Fix it
    // contrast, alongside the plain-FOR-UPDATE blocking time above.
    // eslint-disable-next-line no-console
    console.log(`[SKIP LOCKED test] second claim resolved in ${elapsedMs}ms (no blocking)`);

    // No blocking at all: the second claim returns almost immediately,
    // having skipped the locked row and picked a different one.
    expect(elapsedMs).toBeLessThan(200);
    expect(secondClaim).not.toBeNull();
    expect(secondClaim!.job.id).not.toBe(held.rows[0]!.id);

    await holder.query("ROLLBACK");
    holder.release();

    await cleanupJobs(jobIds);
  });
});
