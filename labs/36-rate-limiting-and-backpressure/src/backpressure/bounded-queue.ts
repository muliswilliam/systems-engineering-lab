import type { Pool } from "pg";
import { sleep } from "../downstream/slow-downstream.js";

/**
 * The backpressure fix: a real, bounded, Postgres-backed queue. Capacity is
 * enforced entirely inside PostgreSQL via a conditional `UPDATE ...
 * WHERE pending_count < capacity` on the single `queue_state` row - the
 * same conditional-write idiom Lab 11 teaches, applied here to a CAPACITY
 * invariant instead of a version column. This is a deliberate application of
 * CLAUDE.md's "prefer datastore-native guarantees" principle: rather than
 * counting in application memory (which would only be correct for one
 * process) or reaching for a Redis counter/lock, a single row's own
 * row-level lock (taken by the `UPDATE`) serializes every concurrent
 * `enqueue` attempt, so the bound holds exactly no matter how many
 * processes are submitting work concurrently.
 *
 * Consumption reuses Lab 14's `SELECT ... FOR UPDATE SKIP LOCKED` claiming
 * pattern (see labs/14-job-queue-skip-locked/src/queue/claim.ts for the full
 * treatment including leases/retries/crash-recovery, none of which this lab
 * re-derives - Lab 36's own subject is capacity, not retry semantics).
 */

/**
 * Resets the single `queue_state` row to a known capacity with
 * `pending_count = 0` and clears `jobs` - used by scenario scripts/tests
 * that need a specific capacity for their own demonstration, independent of
 * whatever `pnpm seed` last set.
 */
export async function resetQueueState(pool: Pool, capacity: number): Promise<void> {
  await pool.query(
    `INSERT INTO queue_state (id, capacity, pending_count) VALUES (1, $1, 0)
     ON CONFLICT (id) DO UPDATE SET capacity = EXCLUDED.capacity, pending_count = 0`,
    [capacity],
  );
  await pool.query(`DELETE FROM jobs`);
}

export interface EnqueueResult {
  accepted: boolean;
  publicId?: string;
  pendingCount: number;
  capacity: number;
}

/**
 * Attempts to enqueue one job. Returns `accepted: false` (a real, immediate
 * "queue full" / overload signal - the backpressure equivalent of a
 * rate limiter's 429) instead of blocking or growing the queue past its
 * configured capacity.
 */
export async function enqueue(pool: Pool): Promise<EnqueueResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const capacityRow = await client.query<{ pending_count: number; capacity: number }>(
      `UPDATE queue_state
       SET pending_count = pending_count + 1
       WHERE id = 1 AND pending_count < capacity
       RETURNING pending_count, capacity`,
    );

    if (capacityRow.rowCount === 0) {
      // Read the current state on the SAME client, not a fresh
      // `pool.query()` call - this bug was caught by this lab's own
      // validation run: under a burst where many concurrent `enqueue`
      // calls are simultaneously rejected, each one would have held its
      // own checked-out client AND asked the pool for a second one for
      // this fallback read. Once every client in the pool was checked out
      // that way, nobody could ever get the second connection they were
      // all waiting for - a self-inflicted pool-exhaustion deadlock in the
      // very lab that teaches protecting a service from overload.
      const current = await client.query<{ pending_count: number; capacity: number }>(
        "SELECT pending_count, capacity FROM queue_state WHERE id = 1",
      );
      await client.query("ROLLBACK");
      const row = current.rows[0];
      return { accepted: false, pendingCount: row?.pending_count ?? 0, capacity: row?.capacity ?? 0 };
    }

    const jobRow = await client.query<{ public_id: string }>(
      `INSERT INTO jobs (status) VALUES ('pending') RETURNING public_id`,
    );
    await client.query("COMMIT");

    const state = capacityRow.rows[0]!;
    return {
      accepted: true,
      publicId: jobRow.rows[0]!.public_id,
      pendingCount: state.pending_count,
      capacity: state.capacity,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Claims exactly one pending job for `workerId` using
 * `FOR UPDATE SKIP LOCKED`, so concurrent workers never claim the same job
 * (identical guarantee to Lab 14). Returns the claimed job's internal id, or
 * `null` if the queue is empty right now.
 */
export async function claimOneJob(pool: Pool, workerId: string): Promise<number | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query<{ id: number }>(
      `SELECT id FROM jobs
       WHERE status = 'pending'
       ORDER BY submitted_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    );
    if (claimed.rowCount === 0) {
      await client.query("COMMIT");
      return null;
    }
    const jobId = claimed.rows[0]!.id;
    await client.query(
      `UPDATE jobs SET status = 'processing', worker_id = $1, started_at = now() WHERE id = $2`,
      [workerId, jobId],
    );
    await client.query("COMMIT");
    return jobId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Marks a claimed job completed AND frees its slot in `queue_state` -
 * this decrement is what lets the bound admit new work again as the
 * backlog drains, rather than latching "full" forever after one burst.
 */
export async function completeJob(pool: Pool, jobId: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE jobs SET status = 'completed', completed_at = now() WHERE id = $1`, [jobId]);
    await client.query(
      `UPDATE queue_state SET pending_count = GREATEST(pending_count - 1, 0) WHERE id = 1`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Runs one worker loop: claim a job, "process" it (a fixed `workMs`
 * simulated downstream call), complete it, repeat, polling when the queue
 * is empty. Runs until `shouldStop()` returns true and the queue is empty.
 */
export async function runBoundedQueueWorker(
  pool: Pool,
  workerId: string,
  workMs: number,
  shouldStop: () => boolean,
): Promise<number> {
  let processedCount = 0;
  for (;;) {
    const jobId = await claimOneJob(pool, workerId);
    if (jobId === null) {
      if (shouldStop()) {
        return processedCount;
      }
      await sleep(20);
      continue;
    }
    await sleep(workMs);
    await completeJob(pool, jobId);
    processedCount += 1;
  }
}
