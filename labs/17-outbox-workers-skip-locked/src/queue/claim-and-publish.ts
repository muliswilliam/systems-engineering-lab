import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import type { SimulatedBroker } from "./broker.js";

export const DEFAULT_LEASE_MS = 5_000;

// Created once per process, not once per claim - many concurrent workers
// each calling createLogger() per call would otherwise construct a new Pino
// instance (and its exit-handler registration) on every single claim
// attempt. `.child({ workerId })` below attaches the per-worker binding
// without paying that cost.
const claimLog = createLogger("lab17:queue:claim");
const publishLog = createLogger("lab17:queue:publish");

export interface ClaimedEvent {
  id: number;
  publicId: string;
  eventType: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  lockedUntil: Date;
}

interface RawOutboxRow {
  // node-postgres returns bigint (OID 20) columns as strings by default.
  id: string;
  public_id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  locked_until: Date;
}

/**
 * The claim, in one transaction: `SELECT ... FOR UPDATE SKIP LOCKED` picks
 * the oldest claimable row (pending, or processing-but-lease-expired) and
 * skips any row a concurrent worker's own claim transaction currently holds
 * a row lock on, instead of blocking behind it. The follow-up `UPDATE` marks
 * it `processing` under THIS worker's name with a fresh lease, still inside
 * the same transaction, so the claim is all-or-nothing per CLAUDE.md's
 * "Job Queues" guidance.
 *
 * `attempts` increments here, on every claim - including a reclaim of a
 * lease-expired row - not when the broker is called. This is what lets a
 * test assert "this event was claimed twice" independently of how many
 * times the broker happened to be called.
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

    // ORDER BY created_at, id: a batch seed inserts many rows in one
    // statement, so `now()` (stable for the whole statement/transaction) is
    // identical across the whole batch - `created_at` alone is not a strict
    // order and ties would be broken arbitrarily. `id` (an always-increasing
    // identity column) makes the ordering fully deterministic without
    // changing which row is "oldest" in any case where created_at actually
    // differs.
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
       SET status = 'processing',
           locked_by = $2,
           locked_until = now() + ($3 || ' milliseconds')::interval,
           attempts = attempts + 1
       WHERE id = $1
       RETURNING id, public_id, event_type, payload, attempts, max_attempts, locked_until`,
      [candidateRow.id, workerId, leaseMs],
    );

    await client.query("COMMIT");

    const row = updated.rows[0]!;
    // node-postgres returns `bigint` (OID 20) columns as strings by default
    // (to avoid silent precision loss past 2^53) - `id` needs an explicit
    // Number() so callers can compare it against the `number`-mode bigint
    // IDs Drizzle's own queries return (e.g. from `.insert().returning()`).
    const id = Number(row.id);
    log.info({ eventId: id, publicId: row.public_id, attempt: row.attempts }, "claimed outbox event");

    return {
      id,
      publicId: row.public_id,
      eventType: row.event_type,
      payload: row.payload,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      lockedUntil: row.locked_until,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    log.error({ err: error }, "claim transaction failed");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Finalizes a successful publish. Guarded by `locked_by = $2` (not just
 * `id = $1`): if this worker's lease already expired and a different worker
 * reclaimed the row, this UPDATE becomes a no-op instead of clobbering
 * whatever the reclaiming worker did - see README "Why the fix works" for
 * why this guard alone does not prevent the duplicate broker call itself.
 */
export async function markPublished(pool: Pool, id: number, workerId: string): Promise<void> {
  await pool.query(
    `UPDATE outbox_events
     SET status = 'published', published_at = now(), locked_by = NULL, locked_until = NULL
     WHERE id = $1 AND locked_by = $2`,
    [id, workerId],
  );
}

/**
 * Records a broker failure. Below `max_attempts`, the row goes back to
 * `pending` (retryable by any worker); at or above it, `failed` is terminal
 * - reimplemented independently here in the same shape as Lab 14's
 * jobs/attempts retry logic, per the independent-labs principle.
 */
export async function markPublishFailed(pool: Pool, id: number, workerId: string): Promise<void> {
  await pool.query(
    `UPDATE outbox_events
     SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
         locked_by = NULL,
         locked_until = NULL
     WHERE id = $1 AND locked_by = $2`,
    [id, workerId],
  );
}

export interface ClaimAndPublishOptions {
  leaseMs?: number;
  /**
   * For the crashed-publisher demonstration ONLY: claim + call the broker,
   * but never run the finalize UPDATE - the row is left at `processing`
   * until its lease expires on its own, exactly like a worker process that
   * died right after the broker call returned. Real callers should never set
   * this.
   */
  skipFinalize?: boolean;
}

export type ClaimAndPublishResult =
  | { claimed: false }
  | { claimed: true; event: ClaimedEvent; published: true }
  | { claimed: true; event: ClaimedEvent; published: false; error: string };

/**
 * The end-to-end happy-path publisher loop body: claim one event, hand it to
 * the broker, then record the outcome. Each of the three steps is its own
 * statement/transaction - deliberately NOT one big transaction, because the
 * broker call is not a database operation and must not hold a Postgres
 * transaction (and its row lock) open for however long an external call
 * takes. That gap between "claimed" and "recorded" is exactly where Lab 17's
 * central lesson lives - see README "Break it".
 */
export async function claimAndPublish(
  pool: Pool,
  broker: SimulatedBroker,
  workerId: string,
  options: ClaimAndPublishOptions = {},
): Promise<ClaimAndPublishResult> {
  const log = publishLog.child({ workerId });
  const event = await claimNextEvent(pool, workerId, options.leaseMs);
  if (!event) {
    return { claimed: false };
  }

  try {
    await broker.publish({ publicId: event.publicId, eventType: event.eventType, payload: event.payload });

    if (options.skipFinalize) {
      log.warn({ eventId: event.id, publicId: event.publicId }, "simulated crash: skipping finalize after successful publish");
      return { claimed: true, event, published: true };
    }

    await markPublished(pool, event.id, workerId);
    log.info({ eventId: event.id, publicId: event.publicId, attempt: event.attempts }, "published outbox event");
    return { claimed: true, event, published: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markPublishFailed(pool, event.id, workerId);
    log.error({ err: error, eventId: event.id, publicId: event.publicId }, "broker publish failed");
    return { claimed: true, event, published: false, error: message };
  }
}
