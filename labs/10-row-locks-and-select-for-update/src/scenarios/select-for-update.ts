import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { SCENARIO_ACCOUNTS } from "../seed/scenario-accounts.js";
import {
  connectClient,
  readBalance,
  readBalanceWithLock,
  resetAccountBalance,
  snapshotLocks,
  sleep,
  type LockSnapshotRow,
} from "./support.js";

const log = createLogger("lab10:scenario:select-for-update");

const ACCOUNT_NAME = "Scenario Account - Select For Update";
const BASELINE_BALANCE_CENTS = SCENARIO_ACCOUNTS.find((a) => a.ownerName === ACCOUNT_NAME)!.balanceCents;
const WITHDRAWAL_A_CENTS = 300_000; // $3,000.00
const WITHDRAWAL_B_CENTS = 200_000; // $2,000.00

export interface WithdrawalOutcome {
  applied: boolean;
  balanceSeen: number;
  newBalance: number | null;
  reason?: "insufficient_funds";
}

export interface SelectForUpdateResult {
  accountId: number;
  baselineBalanceCents: number;
  withdrawalACents: number;
  withdrawalBCents: number;
  outcomeA: WithdrawalOutcome;
  outcomeB: WithdrawalOutcome;
  /** Real wall-clock milliseconds transaction B's `SELECT ... FOR UPDATE`
   * spent blocked, waiting for transaction A's row lock to release. */
  bSelectBlockedMs: number;
  locksWhileBBlocked: LockSnapshotRow[];
  finalBalanceCents: number;
  correctBalanceCents: number;
  bothWithdrawalsCorrectlyReflected: boolean;
}

/**
 * THE FIX: `SELECT ... FOR UPDATE`.
 *
 * Same two concurrent withdrawal attempts as lost-update-without-lock.ts,
 * but each transaction first takes a row lock at read time:
 *
 *   SELECT balance_cents FROM accounts WHERE id = $1 FOR UPDATE
 *
 * Transaction B's `FOR UPDATE` SELECT genuinely BLOCKS until transaction A
 * commits or rolls back - not just B's write, its READ. That is the entire
 * mechanism: B cannot even see a (locked) row's value to compute its
 * decision from until A releases the lock, so B's decision is necessarily
 * based on up-to-date data. Once A commits, B's FOR UPDATE unblocks and
 * returns A's POST-withdrawal balance, so B's own withdrawal is computed
 * against the correct, current balance - either both withdrawals succeed and
 * the final balance reflects both, or B correctly detects insufficient funds
 * and rejects itself. There is no world where B silently overwrites A's
 * withdrawal, because B never got to act on stale data in the first place.
 */
export async function runSelectForUpdate(
  connectionString: string,
  options: { withdrawalACents?: number; withdrawalBCents?: number } = {},
): Promise<SelectForUpdateResult> {
  const withdrawalACents = options.withdrawalACents ?? WITHDRAWAL_A_CENTS;
  const withdrawalBCents = options.withdrawalBCents ?? WITHDRAWAL_B_CENTS;

  const { id: accountId } = await resetAccountBalance(connectionString, ACCOUNT_NAME, BASELINE_BALANCE_CENTS);

  const txA = await connectClient(connectionString);
  const txB = await connectClient(connectionString);
  const observer = await connectClient(connectionString);

  try {
    await txA.client.query("BEGIN");

    const balanceSeenByA = await readBalanceWithLock(txA.client, accountId, "FOR UPDATE");
    log.info({ accountId, balanceSeenByA }, "transaction A: SELECT ... FOR UPDATE - acquires the row lock");

    await txB.client.query("BEGIN");
    const bSelectStartedAt = Date.now();
    const bSelectPromise = readBalanceWithLock(txB.client, accountId, "FOR UPDATE").then((balance) => ({
      balance,
      blockedMs: Date.now() - bSelectStartedAt,
    }));
    log.info(
      { accountId },
      "transaction B: SELECT ... FOR UPDATE issued - this call will block until A commits or rolls back",
    );

    await sleep(250);
    const locksWhileBBlocked = await snapshotLocks(observer.client, [txA.pid, txB.pid]);
    log.info({ accountId, locksWhileBBlocked }, "pg_locks/pg_stat_activity snapshot while B is blocked on A's FOR UPDATE lock");

    const outcomeA = await applyWithdrawal(txA.client, accountId, balanceSeenByA, withdrawalACents);
    log.info({ accountId, outcomeA }, "transaction A: applies its withdrawal decision");
    await txA.client.query("COMMIT");
    log.info({ accountId }, "transaction A: COMMIT - releases the row lock");

    const { balance: balanceSeenByB, blockedMs: bSelectBlockedMs } = await bSelectPromise;
    log.info(
      { accountId, balanceSeenByB, bSelectBlockedMs },
      "transaction B: FOR UPDATE unblocked - sees A's POST-withdrawal balance, not the stale baseline",
    );

    const outcomeB = await applyWithdrawal(txB.client, accountId, balanceSeenByB, withdrawalBCents);
    log.info({ accountId, outcomeB }, "transaction B: applies its withdrawal decision against up-to-date data");
    await txB.client.query("COMMIT");
    log.info({ accountId }, "transaction B: COMMIT");

    const finalBalanceCents = await readBalance(observer.client, accountId);
    const correctBalanceCents =
      BASELINE_BALANCE_CENTS - (outcomeA.applied ? withdrawalACents : 0) - (outcomeB.applied ? withdrawalBCents : 0);

    return {
      accountId,
      baselineBalanceCents: BASELINE_BALANCE_CENTS,
      withdrawalACents,
      withdrawalBCents,
      outcomeA,
      outcomeB,
      bSelectBlockedMs,
      locksWhileBBlocked,
      finalBalanceCents,
      correctBalanceCents,
      bothWithdrawalsCorrectlyReflected: finalBalanceCents === correctBalanceCents,
    };
  } finally {
    await txA.client.end();
    await txB.client.end();
    await observer.client.end();
  }
}

/**
 * Applies (or rejects) a withdrawal against a balance already locked/read by
 * the caller. Handles both real outcomes an application must handle after
 * `FOR UPDATE` gives it a trustworthy read: sufficient funds (apply), or
 * insufficient funds (reject in application code - the row lock guarantees
 * the *read* is current, it does not by itself enforce the business rule).
 */
async function applyWithdrawal(
  client: import("pg").Client,
  accountId: number,
  balanceSeen: number,
  withdrawalCents: number,
): Promise<WithdrawalOutcome> {
  const newBalance = balanceSeen - withdrawalCents;
  if (newBalance < 0) {
    return { applied: false, balanceSeen, newBalance: null, reason: "insufficient_funds" };
  }
  await client.query("UPDATE accounts SET balance_cents = $1 WHERE id = $2", [newBalance, accountId]);
  return { applied: true, balanceSeen, newBalance };
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }

  const result = await runSelectForUpdate(connectionString);

  log.warn(
    { ...result },
    result.bothWithdrawalsCorrectlyReflected
      ? `FIXED: final balance ${result.finalBalanceCents} correctly reflects both withdrawal decisions (baseline minus whichever withdrawals actually applied)`
      : "UNEXPECTED: final balance does not match the correctly-computed value - this would mean FOR UPDATE is not serializing the withdrawals as documented",
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "select-for-update scenario failed");
    process.exit(1);
  });
}
