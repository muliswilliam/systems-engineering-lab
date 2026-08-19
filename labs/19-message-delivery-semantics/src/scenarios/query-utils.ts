import type { Pool } from "pg";
import type { DeliveryAttempt } from "../delivery/sender.js";

/** Shared by every scenario script and the integration tests, per Lab 05/16's
 * pattern: one place to ask "what actually happened to this message?" so the
 * scenario scripts and the tests can't drift apart on how they measure it. */
export async function insertNotification(
  pool: Pool,
  opts: { recipient: string; body: string; scenario: string },
): Promise<{ id: number }> {
  const result = await pool.query<{ id: number }>(
    "INSERT INTO notifications (recipient, body, scenario) VALUES ($1, $2, $3) RETURNING id",
    [opts.recipient, opts.body, opts.scenario],
  );
  return result.rows[0]!;
}

export async function recordDeliveryAttempt(pool: Pool, messageId: number, attempt: DeliveryAttempt): Promise<void> {
  await pool.query(
    "INSERT INTO delivery_log (message_id, attempt_number, outcome) VALUES ($1, $2, $3)",
    [messageId, attempt.attemptNumber, attempt.outcome],
  );
}

export async function setNotificationStatus(
  pool: Pool,
  messageId: number,
  status: "delivered" | "undelivered",
): Promise<void> {
  await pool.query("UPDATE notifications SET status = $1 WHERE id = $2", [status, messageId]);
}

export async function countDeliveryLogRows(pool: Pool, messageId: number): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*)::bigint AS count FROM delivery_log WHERE message_id = $1",
    [messageId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function countDeliveryLogRowsByOutcome(
  pool: Pool,
  messageId: number,
  outcome: string,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*)::bigint AS count FROM delivery_log WHERE message_id = $1 AND outcome = $2",
    [messageId, outcome],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function getReceiverProcessedCount(pool: Pool, messageId: number): Promise<number> {
  const result = await pool.query<{ receiver_processed_count: number }>(
    "SELECT receiver_processed_count FROM notifications WHERE id = $1",
    [messageId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Notification ${messageId} does not exist`);
  }
  return row.receiver_processed_count;
}

export async function countProcessedMessageIdRows(pool: Pool, messageId: number): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*)::bigint AS count FROM processed_message_ids WHERE message_id = $1",
    [messageId],
  );
  return Number(result.rows[0]?.count ?? 0);
}
