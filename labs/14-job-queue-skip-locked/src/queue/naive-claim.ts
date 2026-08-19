import type { Pool } from "pg";

/**
 * THE NAIVE (BROKEN-AT-SCALE) CLAIM - plain `FOR UPDATE`, no `SKIP LOCKED`.
 *
 * Used only by tests/integration/for-update-vs-skip-locked.test.ts to make
 * the "Break it" contrast in README.md real and measured, not just narrated.
 * Never used by the actual worker loop (src/queue/worker.ts) or any of the
 * five required scenarios - those all use claimJob (src/queue/claim.ts).
 *
 * A plain `SELECT ... FOR UPDATE LIMIT 1` picks a candidate row and tries to
 * lock it. If another transaction already holds that exact row's lock, this
 * query BLOCKS until that lock is released - it does not move on to try a
 * different, unlocked row instead. With `ORDER BY created_at LIMIT 1`, every
 * concurrent caller is trying to lock the *same first* candidate row, so a
 * second worker queues up behind the first one even though nine other
 * pending jobs are sitting right there, free.
 */
export async function claimJobPlainForUpdate(
  pool: Pool,
  workerId: string,
): Promise<{ jobId: number; waitedMs: number } | null> {
  const client = await pool.connect();
  const start = Date.now();
  try {
    await client.query("BEGIN");
    const candidate = await client.query<{ id: number }>(
      `SELECT id
       FROM jobs
       WHERE status = 'pending'
       ORDER BY created_at
       FOR UPDATE
       LIMIT 1`,
    );
    const waitedMs = Date.now() - start;
    const row = candidate.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `UPDATE jobs SET status = 'processing', locked_by = $1, updated_at = now() WHERE id = $2`,
      [workerId, row.id],
    );
    await client.query("COMMIT");
    return { jobId: row.id, waitedMs };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
