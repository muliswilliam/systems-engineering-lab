import "dotenv/config";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { getAccountBalanceCents } from "./balance-utils.js";
import { makeCreditAppliedMessage, type CreditAppliedMessage } from "./message.js";

const log = createLogger("lab18:scenario:idempotent");

export type IdempotentOutcome = { outcome: "applied" | "duplicate"; workerId: string };

/**
 * THE FIX.
 *
 * The dedup check/insert AND the business effect happen inside ONE
 * transaction, and the dedup mechanism itself is safe under concurrency
 * because it leans on a real Postgres UNIQUE (here, PRIMARY KEY) constraint
 * via `INSERT ... ON CONFLICT (message_id) DO NOTHING`:
 *
 *   BEGIN
 *   INSERT INTO processed_messages (message_id, ...) VALUES ($1, ...)
 *     ON CONFLICT (message_id) DO NOTHING
 *   -- 0 rows affected -> already processed, ROLLBACK immediately, skip
 *   -- 1 row affected  -> genuinely new, apply the effect in the same tx
 *   UPDATE accounts SET balance_cents = balance_cents + $1 WHERE id = $2
 *   COMMIT
 *
 * Two concurrent callers racing this function against the SAME message_id
 * will both attempt the INSERT. Postgres itself - not application code -
 * guarantees only one of the two concurrent INSERTs can win the primary
 * key; the other blocks briefly on the row-level conflict and then resolves
 * to "0 rows affected" once the winner commits. That is why this is safe
 * under real concurrency and the racy version is not: here, the "is this
 * new?" decision and the business effect are the same atomic unit, enforced
 * by the datastore, not by an if-statement in application code that a
 * scheduler can interleave around.
 */
export async function applyIdempotent(
  pool: Pool,
  message: CreditAppliedMessage,
  workerId: string,
): Promise<IdempotentOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const insertResult = await client.query(
      `INSERT INTO processed_messages (message_id, account_id, amount_cents)
       VALUES ($1, $2, $3)
       ON CONFLICT (message_id) DO NOTHING`,
      [message.messageId, message.accountId, message.amountCents],
    );

    if (insertResult.rowCount === 0) {
      // Already processed (by this exact call, an earlier delivery, or a
      // concurrent winner). Nothing left to do - roll back the (empty)
      // transaction and skip the effect entirely.
      await client.query("ROLLBACK");
      return { outcome: "duplicate", workerId };
    }

    // Genuinely new: this INSERT is what "claims" the message, and the
    // effect below is only durable if this same transaction commits.
    await client.query("UPDATE accounts SET balance_cents = balance_cents + $1 WHERE id = $2", [
      message.amountCents,
      message.accountId,
    ]);

    await client.query("COMMIT");
    return { outcome: "applied", workerId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  const accountResult = await pool.query<{ id: number }>("SELECT id FROM accounts ORDER BY id LIMIT 1");
  const account = accountResult.rows[0];
  if (!account) {
    throw new Error("Need at least 1 account - run `pnpm seed` first");
  }

  const amountCents = 4_000; // $40.00

  // --- 1. Sequential redelivery: same message, delivered twice in a row. ---
  const sequentialMessage = makeCreditAppliedMessage(account.id, amountCents);
  const balanceBeforeSeq = await getAccountBalanceCents(pool, account.id);

  const seqFirst = await applyIdempotent(pool, sequentialMessage, "worker-seq");
  const balanceAfterSeqFirst = await getAccountBalanceCents(pool, account.id);

  const seqSecond = await applyIdempotent(pool, sequentialMessage, "worker-seq");
  const balanceAfterSeqSecond = await getAccountBalanceCents(pool, account.id);

  log.info(
    {
      messageId: sequentialMessage.messageId,
      accountId: account.id,
      amountCents,
      balanceBeforeSeq,
      seqFirst,
      balanceAfterSeqFirst,
      seqSecond,
      balanceAfterSeqSecond,
    },
    balanceAfterSeqSecond === balanceBeforeSeq + amountCents
      ? "FIXED (sequential redelivery): the 2nd delivery was recognized as a duplicate and skipped - effect applied exactly once"
      : "unexpected: sequential redelivery changed the balance more than once",
  );

  // --- 2. Concurrent redelivery: same message, delivered to N workers at
  //        the same instant, over N separate real connections. ---
  const concurrentMessage = makeCreditAppliedMessage(account.id, amountCents);
  const balanceBeforeConcurrent = await getAccountBalanceCents(pool, account.id);

  const WORKER_COUNT = 10;
  const results = await Promise.all(
    Array.from({ length: WORKER_COUNT }, (_, i) => applyIdempotent(pool, concurrentMessage, `worker-${i}`)),
  );

  const balanceAfterConcurrent = await getAccountBalanceCents(pool, account.id);
  const appliedCount = results.filter((r) => r.outcome === "applied").length;
  const duplicateCount = results.filter((r) => r.outcome === "duplicate").length;

  log.info(
    {
      messageId: concurrentMessage.messageId,
      accountId: account.id,
      amountCents,
      workerCount: WORKER_COUNT,
      appliedCount,
      duplicateCount,
      balanceBeforeConcurrent,
      balanceAfterConcurrent,
      expectedIfExactlyOnce: balanceBeforeConcurrent + amountCents,
    },
    appliedCount === 1 && balanceAfterConcurrent === balanceBeforeConcurrent + amountCents
      ? "FIXED (real concurrent redelivery): exactly 1 of N concurrent deliveries applied the effect - Postgres's UNIQUE constraint decided, not application logic"
      : "unexpected: more than one concurrent delivery applied the effect",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "idempotent scenario failed");
    process.exit(1);
  });
}
