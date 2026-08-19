import type { Pool } from "pg";
import type { ClaimedJob, JobRow } from "./types.js";

function rowToJob(row: Record<string, unknown>): JobRow {
  return {
    id: Number(row.id),
    publicId: row.public_id as string,
    jobType: row.job_type as string,
    payload: row.payload as Record<string, unknown>,
    status: row.status as JobRow["status"],
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    lockedBy: (row.locked_by as string | null) ?? null,
    lockedUntil: (row.locked_until as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * THE CLAIM QUERY. This is the mechanism the whole lab is about.
 *
 * A job is claimable when it is genuinely `pending`, OR when it is stuck at
 * `processing` past its lease (`locked_until < now()`) - the second branch is
 * what makes a crashed/hung worker's job reclaimable instead of stuck
 * forever (see README "Lease expiry"). `FOR UPDATE SKIP LOCKED` means: lock
 * the one candidate row this transaction picks, and if another concurrent
 * transaction already holds a row lock on a candidate, skip it and consider
 * the next one - instead of blocking behind it (contrast with
 * naive-claim.ts, which uses plain `FOR UPDATE` and blocks).
 *
 * The whole claim (SELECT ... FOR UPDATE SKIP LOCKED, the UPDATE that marks
 * the job 'processing', and the INSERT of the job_attempts row) happens in
 * one transaction, so two concurrent claims can never both succeed against
 * the same job - Postgres's row lock is the only coordination mechanism
 * here, no application-level mutex or advisory lock is needed.
 */
export async function claimJob(
  pool: Pool,
  workerId: string,
  leaseMs: number,
): Promise<ClaimedJob | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Equivalent raw SQL to SPEC.md's Lab 14 shape, extended with the
    // lease-expiry branch:
    //
    //   SELECT id, status
    //   FROM jobs
    //   WHERE status = 'pending'
    //      OR (status = 'processing' AND locked_until < now())
    //   ORDER BY created_at
    //   FOR UPDATE SKIP LOCKED
    //   LIMIT 1;
    const candidate = await client.query<{ id: number; status: string }>(
      `SELECT id, status
       FROM jobs
       WHERE status = 'pending'
          OR (status = 'processing' AND locked_until < now())
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    );

    const row = candidate.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }

    const reclaimed = row.status === "processing";

    const updated = await client.query(
      `UPDATE jobs
       SET status = 'processing',
           locked_by = $1,
           locked_until = now() + ($2 || ' milliseconds')::interval,
           attempts = attempts + 1,
           updated_at = now()
       WHERE id = $3
       RETURNING *`,
      [workerId, leaseMs, row.id],
    );
    const job = rowToJob(updated.rows[0]!);

    if (reclaimed) {
      // The previous worker's attempt row is still 'claimed' - it never
      // completed or failed the job. Mark it 'expired' so the audit trail
      // shows exactly one 'claimed' row per job at any instant.
      await client.query(
        `UPDATE job_attempts
         SET status = 'expired', released_at = now()
         WHERE job_id = $1 AND status = 'claimed'`,
        [job.id],
      );
    }

    const attemptInsert = await client.query<{ id: number }>(
      `INSERT INTO job_attempts (job_id, worker_id, attempt_number, status, claimed_at)
       VALUES ($1, $2, $3, 'claimed', now())
       RETURNING id`,
      [job.id, workerId, job.attempts],
    );

    await client.query("COMMIT");
    return { job, attemptId: attemptInsert.rows[0]!.id, reclaimed };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeJob(pool: Pool, jobId: number, attemptId: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE jobs
       SET status = 'completed', locked_by = NULL, locked_until = NULL, updated_at = now()
       WHERE id = $1`,
      [jobId],
    );
    await client.query(
      `UPDATE job_attempts SET status = 'completed', released_at = now() WHERE id = $1`,
      [attemptId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface FailResult {
  terminal: boolean;
  attempts: number;
  maxAttempts: number;
}

/**
 * Records a failed attempt. If the job's attempts counter has now reached
 * max_attempts, the job moves to the terminal 'failed' status and is
 * excluded from all future claims (the claim query only ever selects
 * 'pending' or lease-expired 'processing' rows). Otherwise it goes back to
 * 'pending' and becomes claimable again immediately.
 */
export async function failJob(
  pool: Pool,
  jobId: number,
  attemptId: number,
  errorMessage: string,
): Promise<FailResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const jobResult = await client.query<{ attempts: number; max_attempts: number }>(
      `SELECT attempts, max_attempts FROM jobs WHERE id = $1 FOR UPDATE`,
      [jobId],
    );
    const jobRow = jobResult.rows[0];
    if (!jobRow) {
      throw new Error(`job ${jobId} does not exist`);
    }
    const terminal = jobRow.attempts >= jobRow.max_attempts;

    await client.query(
      `UPDATE jobs
       SET status = $1, locked_by = NULL, locked_until = NULL, last_error = $2, updated_at = now()
       WHERE id = $3`,
      [terminal ? "failed" : "pending", errorMessage, jobId],
    );
    await client.query(
      `UPDATE job_attempts SET status = 'failed', released_at = now(), error = $1 WHERE id = $2`,
      [errorMessage, attemptId],
    );
    await client.query("COMMIT");
    return { terminal, attempts: jobRow.attempts, maxAttempts: jobRow.max_attempts };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
