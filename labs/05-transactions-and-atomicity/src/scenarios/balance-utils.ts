import type { Pool } from "pg";

/**
 * Shared by both scenario scripts and the integration tests: "total balance
 * across all accounts" is the invariant this whole lab is about, so both the
 * naive (broken) and transactional (fixed) scenarios measure it the same
 * way, and the tests assert on it directly rather than re-deriving it.
 */
export async function getTotalBalanceCents(pool: Pool): Promise<number> {
  const result = await pool.query<{ total: string }>(
    "SELECT coalesce(sum(balance_cents), 0)::bigint AS total FROM accounts",
  );
  return Number(result.rows[0]?.total ?? 0);
}

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
