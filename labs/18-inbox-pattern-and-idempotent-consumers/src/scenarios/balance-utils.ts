import type { Pool } from "pg";

/** Shared by every scenario script and every test file: all three consumers
 * are judged against the same two queries, so the naive/racy/idempotent
 * comparison is apples-to-apples. */
export async function getAccountBalanceCents(pool: Pool, accountId: number): Promise<number> {
  const result = await pool.query<{ balance_cents: number }>(
    "SELECT balance_cents FROM accounts WHERE id = $1",
    [accountId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Account ${accountId} does not exist`);
  }
  return row.balance_cents;
}

export async function countProcessedMessages(pool: Pool, messageId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*)::bigint AS count FROM processed_messages WHERE message_id = $1",
    [messageId],
  );
  return Number(result.rows[0]?.count ?? 0);
}
