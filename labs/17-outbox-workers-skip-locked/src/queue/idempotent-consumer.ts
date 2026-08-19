import type { Pool } from "pg";
import type { BrokerEvent } from "./broker.js";

export interface IdempotentConsumeResult {
  duplicate: boolean;
}

/**
 * A PREVIEW of Lab 18 (Inbox Pattern and Idempotent Consumers) - NOT a full
 * implementation. Per CLAUDE.md's explicit instruction ("Do not imply that
 * the outbox magically prevents duplicate publication. Consumers must be
 * taught to be idempotent"), this function exists only to make one narrow
 * point concrete: once the CONSUMER remembers which event `public_id`s it
 * has already applied, a broker call that happens twice (see
 * crashed-publisher-duplicate-delivery.ts) stops being dangerous, because
 * the side effect only runs once.
 *
 * What this preview does NOT cover (left to Lab 18):
 *   - retention/cleanup of `processed_events` (it grows forever here);
 *   - ordering guarantees across partitions/consumers;
 *   - what happens if `applySideEffect` itself fails after the INSERT
 *     commits (a real inbox needs the insert and the side effect in the same
 *     transaction, or a separate outbox on the consumer's side - "turtles
 *     all the way down" is exactly why Lab 18 is its own lab);
 *   - multiple consumer instances processing the same inbox concurrently
 *     (this preview is called sequentially in this lab's scenario).
 *
 * Uses Postgres's own UNIQUE constraint via `INSERT ... ON CONFLICT DO
 * NOTHING` rather than an application-level "check, then insert" - a
 * two-statement check-then-act has exactly the same race an outbox claim
 * would have without `SKIP LOCKED`'s atomic claim. `RETURNING id` reports,
 * in the same round trip, whether this call was the first to see this
 * `public_id` - this is CLAUDE.md's "prefer datastore-native guarantees"
 * principle applied to deduplication instead of application-level checks.
 */
export async function consumeIdempotently(
  pool: Pool,
  event: BrokerEvent,
  applySideEffect: (event: BrokerEvent) => void,
): Promise<IdempotentConsumeResult> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO processed_events (event_public_id)
     VALUES ($1)
     ON CONFLICT (event_public_id) DO NOTHING
     RETURNING id`,
    [event.publicId],
  );

  if (result.rowCount === 0) {
    return { duplicate: true };
  }

  applySideEffect(event);
  return { duplicate: false };
}
