import type { Pool } from "pg";
import { createLogger } from "@labs/logging";

export const DEFAULT_LEASE_MS = 5_000;

const claimLog = createLogger("lab40:outbox:claim");

export interface ClaimedEvent {
  id: number;
  publicId: string;
  eventType: string;
  payload: { orderPublicId: string; correlationId: string; customerEmail: string; amountCents: number };
  attempts: number;
  maxAttempts: number;
}

interface RawOutboxRow {
  id: string;
  public_id: string;
  event_type: string;
  payload: ClaimedEvent["payload"];
  attempts: number;
  max_attempts: number;
}

/**
 * `SELECT ... FOR UPDATE SKIP LOCKED`, reused fresh from Lab 17's own
 * `claimNextEvent` (independent copy) - see that lab's README for the full
 * mechanics. Multiple publisher workers can run this concurrently against
 * the same table and never double-claim the same row; a worker that "died"
 * mid-publish leaves its claimed row reclaimable once `locked_until` lapses.
 */
export async function claimNextEvent(
  pool: Pool,
  workerId: string,
  leaseMs: number = DEFAULT_LEASE_MS,
): Promise<ClaimedEvent | null> {
  const log = claimLog.child({ workerId });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const candidate = await client.query<{ id: string }>(
      `SELECT id
       FROM outbox_events
       WHERE status = 'pending' OR (status = 'processing' AND locked_until < now())
       ORDER BY created_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    );

    const candidateRow = candidate.rows[0];
    if (!candidateRow) {
      await client.query("COMMIT");
      return null;
    }

    const updated = await client.query<RawOutboxRow>(
      `UPDATE outbox_events
       SET status = 'processing', locked_by = $2,
           locked_until = now() + ($3 || ' milliseconds')::interval,
           attempts = attempts + 1
       WHERE id = $1
       RETURNING id, public_id, event_type, payload, attempts, max_attempts`,
      [candidateRow.id, workerId, leaseMs],
    );

    await client.query("COMMIT");

    const row = updated.rows[0]!;
    const id = Number(row.id);
    log.info({ eventId: id, publicId: row.public_id, attempt: row.attempts }, "claimed outbox event");

    return {
      id,
      publicId: row.public_id,
      eventType: row.event_type,
      payload: row.payload,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    log.error({ err: error }, "claim transaction failed");
    throw error;
  } finally {
    client.release();
  }
}

export async function markPublished(pool: Pool, id: number, workerId: string): Promise<void> {
  await pool.query(
    `UPDATE outbox_events
     SET status = 'published', published_at = now(), locked_by = NULL, locked_until = NULL
     WHERE id = $1 AND locked_by = $2`,
    [id, workerId],
  );
}

export async function markPublishFailed(pool: Pool, id: number, workerId: string): Promise<void> {
  await pool.query(
    `UPDATE outbox_events
     SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
         locked_by = NULL, locked_until = NULL
     WHERE id = $1 AND locked_by = $2`,
    [id, workerId],
  );
}

export async function pendingOutboxCount(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM outbox_events WHERE status IN ('pending', 'processing')`,
  );
  return Number(rows[0]?.count ?? 0);
}
