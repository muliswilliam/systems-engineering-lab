import type { Client } from "pg";

/**
 * Shared by concurrent-index-vs-blocking.ts and lock-timeout-fail-fast.ts:
 * both scenarios need the same setup - "a long-running transaction that has
 * WRITTEN to the target table" (not just read it), held open for a
 * measurable amount of wall-clock time before it commits. A plain UPDATE
 * that sets a column to its own value is a real write: it acquires the same
 * row lock (and the same table-level ROW EXCLUSIVE lock) a normal write
 * would, without changing any data.
 */
export async function holdWriteLockingTransaction(
  client: Client,
  customerId: number,
  holdMs: number,
): Promise<void> {
  await client.query("BEGIN");
  await client.query("UPDATE customers SET country = country WHERE id = $1", [customerId]);
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  await client.query("COMMIT");
}
