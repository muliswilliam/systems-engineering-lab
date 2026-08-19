import "dotenv/config";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { getAccountBalanceCents, getTotalBalanceCents } from "./balance-utils.js";

const log = createLogger("lab05:scenario:naive");

export interface NaiveTransferOptions {
  fromAccountId: number;
  toAccountId: number;
  amountCents: number;
  /** Simulates a process crash / uncaught exception right after the debit
   * commits and right before the credit statement runs. */
  injectFailureAfterDebit: boolean;
}

export interface NaiveTransferResult {
  transferId: number;
  debited: boolean;
  credited: boolean;
}

/**
 * Thrown when `injectFailureAfterDebit` fires. Carries the `transferId` so
 * callers (the demo below, and the test suite) can go inspect exactly what
 * state that transfer's row and the two accounts were left in - the same way
 * an on-call engineer would query the database after a real crash, since the
 * crashed process itself has no more code running to report anything.
 */
export class SimulatedCrashError extends Error {
  constructor(
    message: string,
    public readonly transferId: number,
  ) {
    super(message);
    this.name = "SimulatedCrashError";
  }
}

/**
 * THE NAIVE (BROKEN) TRANSFER.
 *
 * Debits one account and credits another using two *independent* SQL
 * statements, neither wrapped in an explicit `BEGIN`/`COMMIT`. Under
 * Postgres's autocommit behavior, each bare statement is its own implicit
 * transaction: the moment the debit `UPDATE` resolves, it is already
 * committed and durable, with no relationship to whatever happens next.
 *
 * If the process fails (crashes, throws, loses its connection) between the
 * two statements, the debit stays committed and the credit never happens -
 * money has vanished from the system's point of view. See README.md "Break
 * it" for a real captured run of this happening.
 */
export async function performNaiveTransfer(
  pool: Pool,
  opts: NaiveTransferOptions,
): Promise<NaiveTransferResult> {
  const insertResult = await pool.query<{ id: number }>(
    `INSERT INTO transfers (from_account_id, to_account_id, amount_cents, mechanism, status)
     VALUES ($1, $2, $3, 'naive', 'pending')
     RETURNING id`,
    [opts.fromAccountId, opts.toAccountId, opts.amountCents],
  );
  const transferId = insertResult.rows[0]!.id;

  // --- Statement 1: debit the source account. -----------------------------
  // This is a complete, independent statement. Postgres commits it the
  // instant it succeeds - there is no open transaction tying it to what
  // comes next. `accounts_balance_cents_non_negative` still protects THIS
  // statement (an overdraft is rejected atomically, on its own), but nothing
  // protects the *pair* of statements.
  await pool.query("UPDATE accounts SET balance_cents = balance_cents - $1 WHERE id = $2", [
    opts.amountCents,
    opts.fromAccountId,
  ]);

  if (opts.injectFailureAfterDebit) {
    // The debit above already committed. Nothing runs after this line -
    // exactly like a real process crash, there is no `catch` here that
    // "cleans up" by marking the transfer failed. The transfer row is left
    // behind at `status = 'pending'` forever; that stuck-pending row is
    // itself the symptom a monitoring query would catch in production (see
    // README "Production notes").
    throw new SimulatedCrashError(
      "simulated crash after debit, before credit (naive, non-transactional transfer)",
      transferId,
    );
  }

  // --- Statement 2: credit the destination account. ------------------------
  // A second, equally independent statement - Postgres has no idea it is
  // "supposed to" go together with statement 1.
  await pool.query("UPDATE accounts SET balance_cents = balance_cents + $1 WHERE id = $2", [
    opts.amountCents,
    opts.toAccountId,
  ]);
  await pool.query("UPDATE transfers SET status = 'completed', completed_at = now() WHERE id = $1", [
    transferId,
  ]);

  return { transferId, debited: true, credited: true };
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

  log.info("--- 1. naive transfer, happy path (no injected failure) ---");
  const totalBefore1 = await getTotalBalanceCents(pool);
  const result1 = await performNaiveTransfer(pool, {
    fromAccountId: from.id,
    toAccountId: to.id,
    amountCents,
    injectFailureAfterDebit: false,
  });
  const totalAfter1 = await getTotalBalanceCents(pool);
  log.info(
    { transferId: result1.transferId, totalBefore: totalBefore1, totalAfter: totalAfter1 },
    totalBefore1 === totalAfter1
      ? "happy path: total balance preserved (no crash occurred, so both statements ran)"
      : "unexpected: total balance changed on the happy path",
  );

  log.info("--- 2. naive transfer, crash injected between debit and credit ---");
  const totalBefore2 = await getTotalBalanceCents(pool);
  const fromBalanceBefore2 = await getAccountBalanceCents(pool, from.id);
  const toBalanceBefore2 = await getAccountBalanceCents(pool, to.id);

  let crash: SimulatedCrashError | undefined;
  try {
    await performNaiveTransfer(pool, {
      fromAccountId: from.id,
      toAccountId: to.id,
      amountCents,
      injectFailureAfterDebit: true,
    });
  } catch (error) {
    if (error instanceof SimulatedCrashError) {
      crash = error;
    } else {
      throw error;
    }
  }

  const totalAfter2 = await getTotalBalanceCents(pool);
  const fromBalanceAfter2 = await getAccountBalanceCents(pool, from.id);
  const toBalanceAfter2 = await getAccountBalanceCents(pool, to.id);
  const transferRow = crash
    ? (await pool.query("SELECT status FROM transfers WHERE id = $1", [crash.transferId])).rows[0]
    : undefined;

  log.warn(
    {
      transferId: crash?.transferId,
      transferStatus: transferRow?.status,
      amountCents,
      fromAccountId: from.id,
      toAccountId: to.id,
      fromBalanceBefore: fromBalanceBefore2,
      fromBalanceAfter: fromBalanceAfter2,
      toBalanceBefore: toBalanceBefore2,
      toBalanceAfter: toBalanceAfter2,
      totalBalanceBefore: totalBefore2,
      totalBalanceAfter: totalAfter2,
      moneyVanishedCents: totalBefore2 - totalAfter2,
    },
    totalBefore2 !== totalAfter2
      ? "CORRUPTED: total balance across all accounts changed - money vanished"
      : "unexpected: total balance was preserved despite the injected failure",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "naive scenario failed");
    process.exit(1);
  });
}
