import "dotenv/config";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { getAccountBalanceCents, getTotalBalanceCents } from "./balance-utils.js";

const log = createLogger("lab05:scenario:transactional");

export interface TransactionalTransferOptions {
  fromAccountId: number;
  toAccountId: number;
  amountCents: number;
  /** Same injection point as the naive transfer, for a fair comparison: the
   * failure happens after the debit statement runs but before the credit
   * statement runs - the only difference is what surrounds it. */
  injectFailureAfterDebit: boolean;
}

export type TransactionalTransferResult =
  | { committed: true; transferId: number }
  | { committed: false; transferId: number; reason: string };

/**
 * THE FIX: the exact same two statements as naive-transfer.ts, wrapped in an
 * explicit `BEGIN ... COMMIT`, with the injected failure now triggering a
 * `ROLLBACK` instead of leaving a stuck row behind.
 *
 * A single Postgres transaction is atomic: either every statement inside it
 * becomes durable together at `COMMIT`, or none of them do. If anything
 * throws before `COMMIT`, `ROLLBACK` undoes every statement issued so far on
 * this connection since `BEGIN` - including the debit `UPDATE` *and* the
 * `INSERT` that created the `pending` transfer row itself. Nothing partial
 * is ever visible to any other connection, because Postgres does not make
 * uncommitted writes visible outside the transaction that made them (this is
 * ordinary Read Committed behavior - see Lab 07).
 */
export async function performTransactionalTransfer(
  pool: Pool,
  opts: TransactionalTransferOptions,
): Promise<TransactionalTransferResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const insertResult = await client.query<{ id: number }>(
      `INSERT INTO transfers (from_account_id, to_account_id, amount_cents, mechanism, status)
       VALUES ($1, $2, $3, 'transactional', 'pending')
       RETURNING id`,
      [opts.fromAccountId, opts.toAccountId, opts.amountCents],
    );
    const transferId = insertResult.rows[0]!.id;

    // Statement 1: debit the source account - NOT independently committed
    // this time. It is only durable once COMMIT below succeeds.
    await client.query("UPDATE accounts SET balance_cents = balance_cents - $1 WHERE id = $2", [
      opts.amountCents,
      opts.fromAccountId,
    ]);

    if (opts.injectFailureAfterDebit) {
      throw new Error("simulated crash after debit, before credit (transactional transfer)");
    }

    // Statement 2: credit the destination account - part of the same
    // transaction as statement 1.
    await client.query("UPDATE accounts SET balance_cents = balance_cents + $1 WHERE id = $2", [
      opts.amountCents,
      opts.toAccountId,
    ]);
    await client.query(
      "UPDATE transfers SET status = 'completed', completed_at = now() WHERE id = $1",
      [transferId],
    );

    await client.query("COMMIT");
    return { committed: true, transferId };
  } catch (error) {
    await client.query("ROLLBACK");
    const reason = error instanceof Error ? error.message : String(error);

    // The `pending` row inserted above was rolled back along with the debit
    // - it no longer exists. This audit row is a NEW, separate statement,
    // issued after the rollback completed, on its own implicit transaction -
    // it does not (and must not) touch `accounts`, so it cannot reintroduce
    // any of the partial state the rollback just erased.
    const failureInsert = await pool.query<{ id: number }>(
      `INSERT INTO transfers (from_account_id, to_account_id, amount_cents, mechanism, status, failure_reason)
       VALUES ($1, $2, $3, 'transactional', 'failed', $4)
       RETURNING id`,
      [opts.fromAccountId, opts.toAccountId, opts.amountCents, reason],
    );

    return { committed: false, transferId: failureInsert.rows[0]!.id, reason };
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  const accountsResult = await pool.query<{ id: number }>(
    "SELECT id FROM accounts ORDER BY id LIMIT 2",
  );
  const [from, to] = accountsResult.rows;
  if (!from || !to) {
    throw new Error("Need at least 2 accounts - run `pnpm seed` first");
  }

  const amountCents = 1_000; // $10.00

  log.info("--- 1. transactional transfer, happy path (no injected failure) ---");
  const totalBefore1 = await getTotalBalanceCents(pool);
  const fromBefore1 = await getAccountBalanceCents(pool, from.id);
  const toBefore1 = await getAccountBalanceCents(pool, to.id);

  const result1 = await performTransactionalTransfer(pool, {
    fromAccountId: from.id,
    toAccountId: to.id,
    amountCents,
    injectFailureAfterDebit: false,
  });

  const totalAfter1 = await getTotalBalanceCents(pool);
  const fromAfter1 = await getAccountBalanceCents(pool, from.id);
  const toAfter1 = await getAccountBalanceCents(pool, to.id);

  log.info(
    {
      ...result1,
      totalBefore: totalBefore1,
      totalAfter: totalAfter1,
      fromBefore: fromBefore1,
      fromAfter: fromAfter1,
      toBefore: toBefore1,
      toAfter: toAfter1,
    },
    "happy path committed: source debited, destination credited, total preserved",
  );

  log.info("--- 2. transactional transfer, crash injected between debit and credit ---");
  const totalBefore2 = await getTotalBalanceCents(pool);
  const fromBefore2 = await getAccountBalanceCents(pool, from.id);
  const toBefore2 = await getAccountBalanceCents(pool, to.id);

  const result2 = await performTransactionalTransfer(pool, {
    fromAccountId: from.id,
    toAccountId: to.id,
    amountCents,
    injectFailureAfterDebit: true,
  });

  const totalAfter2 = await getTotalBalanceCents(pool);
  const fromAfter2 = await getAccountBalanceCents(pool, from.id);
  const toAfter2 = await getAccountBalanceCents(pool, to.id);

  log.info(
    {
      ...result2,
      totalBefore: totalBefore2,
      totalAfter: totalAfter2,
      fromBefore: fromBefore2,
      fromAfter: fromAfter2,
      toBefore: toBefore2,
      toAfter: toAfter2,
    },
    totalBefore2 === totalAfter2 && fromBefore2 === fromAfter2 && toBefore2 === toAfter2
      ? "PRESERVED: ROLLBACK undid the debit - total balance and both individual balances are byte-for-byte unchanged"
      : "unexpected: balances changed despite the rollback",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "transactional scenario failed");
    process.exit(1);
  });
}
