import type { Pool } from "pg";

/**
 * THE NAIVE RECEIVER: applies the business effect (incrementing
 * `receiver_processed_count`) every single time it is invoked, with no
 * memory of ever having seen this message id before. Used by
 * at-most-once.ts and at-least-once.ts. This is not a strawman - it is
 * exactly what "just process the message" code looks like before anyone
 * adds idempotency, and it is exactly why at-least-once's ack-loss case
 * produces a real duplicate business effect (see README.md "Break it").
 */
export async function naiveProcessMessage(pool: Pool, messageId: number): Promise<void> {
  await pool.query(
    "UPDATE notifications SET receiver_processed_count = receiver_processed_count + 1 WHERE id = $1",
    [messageId],
  );
}

export interface IdempotentProcessResult {
  /** true only the first time this message id is successfully processed;
   * false every subsequent time, even though the receiver was invoked. */
  applied: boolean;
}

/**
 * THE IDEMPOTENT RECEIVER (the fix): before applying any business effect,
 * tries to claim the message id in `processed_message_ids` via
 * `INSERT ... ON CONFLICT (message_id) DO NOTHING`. The claim and the
 * business effect happen in the SAME transaction, so "we decided to apply
 * this" and "we recorded that we applied it" are atomic with each other -
 * there is no window where a crash between the two could let a retry either
 * skip the effect it should apply, or apply an effect it should skip.
 *
 * Used only by effectively-once.ts. It is invoked through the identical
 * `sendWithRetry` mechanism at-least-once.ts uses - the transport can still
 * genuinely deliver the same message twice (see delivery_log), but the
 * second delivery's `INSERT` finds the row already there, does nothing, and
 * `applied` comes back `false`.
 */
export async function idempotentProcessMessage(pool: Pool, messageId: number): Promise<IdempotentProcessResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const claim = await client.query(
      "INSERT INTO processed_message_ids (message_id) VALUES ($1) ON CONFLICT (message_id) DO NOTHING RETURNING id",
      [messageId],
    );

    const applied = (claim.rowCount ?? 0) > 0;
    if (applied) {
      await client.query(
        "UPDATE notifications SET receiver_processed_count = receiver_processed_count + 1 WHERE id = $1",
        [messageId],
      );
    }

    await client.query("COMMIT");
    return { applied };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
