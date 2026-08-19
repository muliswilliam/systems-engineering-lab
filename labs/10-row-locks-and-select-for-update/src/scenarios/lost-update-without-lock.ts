import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { SCENARIO_ACCOUNTS } from "../seed/scenario-accounts.js";
import { connectClient, readBalance, resetAccountBalance, snapshotLocks, sleep, type LockSnapshotRow } from "./support.js";

const log = createLogger("lab10:scenario:lost-update");

const ACCOUNT_NAME = "Scenario Account - Lost Update";
const BASELINE_BALANCE_CENTS = SCENARIO_ACCOUNTS.find((a) => a.ownerName === ACCOUNT_NAME)!.balanceCents;
const WITHDRAWAL_A_CENTS = 300_000; // $3,000.00
const WITHDRAWAL_B_CENTS = 200_000; // $2,000.00

export interface LostUpdateResult {
  accountId: number;
  baselineBalanceCents: number;
  withdrawalACents: number;
  withdrawalBCents: number;
  balanceReadByA: number;
  balanceReadByB: number;
  newBalanceComputedByA: number;
  newBalanceComputedByB: number;
  /** Real wall-clock milliseconds transaction B's UPDATE spent waiting for
   * transaction A's still-open UPDATE to release its row lock. Even though
   * the WRITE blocks (Postgres always takes a row lock for UPDATE), that
   * blocking does nothing to prevent the lost update below, because B's
   * UPDATE blindly overwrites with a value computed from a stale read. */
  bUpdateBlockedMs: number;
  locksWhileBBlocked: LockSnapshotRow[];
  finalBalanceCents: number;
  correctBalanceCents: number;
  lostUpdateOccurred: boolean;
}

/**
 * THE NAIVE (BROKEN) CONCURRENT WITHDRAWAL.
 *
 * Two transactions each do:
 *   1. SELECT balance_cents FROM accounts WHERE id = $1        (plain read, no lock)
 *   2. compute newBalance = oldBalance - withdrawalAmount       (in application code)
 *   3. UPDATE accounts SET balance_cents = $newBalance WHERE id = $1
 *
 * Both reads happen before either write, so both transactions compute their
 * "new" balance from the SAME stale baseline. Postgres's row-level lock for
 * UPDATE still applies here - B's UPDATE physically blocks until A's
 * transaction commits or rolls back - but that lock protects the *storage*,
 * not the *invariant*: B's UPDATE writes an absolute value it already
 * computed from data that is now out of date. Whichever UPDATE commits last
 * wins outright and silently erases the other transaction's withdrawal. Both
 * withdrawals "succeed" from the application's point of view (no error, no
 * CHECK violation - each individual UPDATE leaves the balance >= 0), yet the
 * final balance reflects only one of the two withdrawals.
 */
export async function runLostUpdate(connectionString: string): Promise<LostUpdateResult> {
  const { id: accountId } = await resetAccountBalance(connectionString, ACCOUNT_NAME, BASELINE_BALANCE_CENTS);

  const txA = await connectClient(connectionString);
  const txB = await connectClient(connectionString);
  const observer = await connectClient(connectionString);

  try {
    await txA.client.query("BEGIN");
    await txB.client.query("BEGIN");

    // Both reads happen before either write - the defining shape of a lost
    // update. Neither takes a lock: a plain SELECT never blocks a concurrent
    // writer in Postgres's MVCC model (see Lab 06).
    const balanceReadByA = await readBalance(txA.client, accountId);
    log.info({ accountId, balanceReadByA }, "transaction A: plain SELECT (no lock)");

    const balanceReadByB = await readBalance(txB.client, accountId);
    log.info({ accountId, balanceReadByB }, "transaction B: plain SELECT (no lock) - same stale baseline as A");

    const newBalanceComputedByA = balanceReadByA - WITHDRAWAL_A_CENTS;
    const newBalanceComputedByB = balanceReadByB - WITHDRAWAL_B_CENTS;

    // Transaction A writes its absolute computed value and stays open
    // (does not commit yet) - this holds a row-exclusive lock on the row.
    await txA.client.query("UPDATE accounts SET balance_cents = $1 WHERE id = $2", [
      newBalanceComputedByA,
      accountId,
    ]);
    log.info(
      { accountId, newBalanceComputedByA },
      "transaction A: UPDATE with its computed value (not yet committed)",
    );

    // Transaction B's UPDATE targets the same row while A still holds the
    // lock, so it blocks. Fire it without awaiting yet so we can observe the
    // block from a third connection and measure real wall-clock wait time.
    const bUpdateStartedAt = Date.now();
    const bUpdatePromise = txB.client
      .query("UPDATE accounts SET balance_cents = $1 WHERE id = $2", [newBalanceComputedByB, accountId])
      .then(() => Date.now() - bUpdateStartedAt);
    log.info(
      { accountId, newBalanceComputedByB },
      "transaction B: UPDATE issued - this call will block until A commits or rolls back",
    );

    // Give B's UPDATE time to actually register as blocked before snapshotting.
    await sleep(250);
    const locksWhileBBlocked = await snapshotLocks(observer.client, [txA.pid, txB.pid]);
    log.info({ accountId, locksWhileBBlocked }, "pg_locks/pg_stat_activity snapshot while B is blocked on A's lock");

    await txA.client.query("COMMIT");
    log.info({ accountId }, "transaction A: COMMIT - releases the row lock");

    const bUpdateBlockedMs = await bUpdatePromise;
    log.info({ accountId, bUpdateBlockedMs }, "transaction B: UPDATE unblocked and applied");

    await txB.client.query("COMMIT");
    log.info({ accountId }, "transaction B: COMMIT");

    const finalBalanceCents = await readBalance(observer.client, accountId);
    const correctBalanceCents = BASELINE_BALANCE_CENTS - WITHDRAWAL_A_CENTS - WITHDRAWAL_B_CENTS;

    return {
      accountId,
      baselineBalanceCents: BASELINE_BALANCE_CENTS,
      withdrawalACents: WITHDRAWAL_A_CENTS,
      withdrawalBCents: WITHDRAWAL_B_CENTS,
      balanceReadByA,
      balanceReadByB,
      newBalanceComputedByA,
      newBalanceComputedByB,
      bUpdateBlockedMs,
      locksWhileBBlocked,
      finalBalanceCents,
      correctBalanceCents,
      lostUpdateOccurred: finalBalanceCents !== correctBalanceCents,
    };
  } finally {
    await txA.client.end();
    await txB.client.end();
    await observer.client.end();
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }

  const result = await runLostUpdate(connectionString);

  log.warn(
    { ...result },
    result.lostUpdateOccurred
      ? `LOST UPDATE confirmed: final balance ${result.finalBalanceCents} does not equal the correct balance ${result.correctBalanceCents} (baseline minus BOTH withdrawals) - one withdrawal vanished`
      : "UNEXPECTED: no lost update occurred - this would mean the naive read-modify-write is not racing as documented",
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "lost-update-without-lock scenario failed");
    process.exit(1);
  });
}
