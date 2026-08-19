import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { SCENARIO_ACCOUNTS } from "../seed/scenario-accounts.js";
import {
  connectClient,
  isPgError,
  readBalanceWithLock,
  resetAccountBalance,
  snapshotLocks,
  sleep,
  type LockSnapshotRow,
} from "./support.js";

const log = createLogger("lab10:scenario:nowait-and-lock-timeout");

const ACCOUNT_NAME = "Scenario Account - Nowait Lock Timeout";
const BASELINE_BALANCE_CENTS = SCENARIO_ACCOUNTS.find((a) => a.ownerName === ACCOUNT_NAME)!.balanceCents;
const LOCK_TIMEOUT_MS = 500;

export interface NowaitResult {
  accountId: number;
  errorCode: string | undefined;
  errorMessage: string | undefined;
  elapsedMs: number;
  raisedImmediately: boolean;
}

/**
 * `SELECT ... FOR UPDATE NOWAIT` against a row already locked by another
 * open transaction does not wait at all - it raises an error the instant it
 * discovers the row is locked. This is the opposite tradeoff from a plain
 * `FOR UPDATE`: instead of blocking (and tying up a connection/worker while
 * it waits), the caller gets an immediate, actionable failure it can retry,
 * queue, or surface to the user.
 *
 * The real error Postgres raises (confirmed against a running instance, not
 * assumed): SQLSTATE `55P03` (`lock_not_available`), message
 * `could not obtain lock on row in relation "accounts"`.
 */
export async function runNowait(connectionString: string): Promise<NowaitResult> {
  const { id: accountId } = await resetAccountBalance(connectionString, ACCOUNT_NAME, BASELINE_BALANCE_CENTS);

  const txA = await connectClient(connectionString);
  const txB = await connectClient(connectionString);

  try {
    await txA.client.query("BEGIN");
    await readBalanceWithLock(txA.client, accountId, "FOR UPDATE");
    log.info({ accountId }, "transaction A: SELECT ... FOR UPDATE - holds the row lock, stays open");

    await txB.client.query("BEGIN");
    const startedAt = Date.now();
    let errorCode: string | undefined;
    let errorMessage: string | undefined;
    try {
      await readBalanceWithLock(txB.client, accountId, "FOR UPDATE NOWAIT");
    } catch (error) {
      if (isPgError(error)) {
        errorCode = error.code;
        errorMessage = error.message;
      } else {
        throw error;
      }
    }
    const elapsedMs = Date.now() - startedAt;
    log.info({ accountId, errorCode, errorMessage, elapsedMs }, "transaction B: SELECT ... FOR UPDATE NOWAIT result");

    await txB.client.query("ROLLBACK");
    await txA.client.query("ROLLBACK");

    return {
      accountId,
      errorCode,
      errorMessage,
      elapsedMs,
      // "Immediately" here means bounded well under the time a real block
      // would take (this lab's lock-timeout demo below waits 500ms+ on
      // purpose) - not a timing-precision claim.
      raisedImmediately: elapsedMs < 250,
    };
  } finally {
    await txA.client.end();
    await txB.client.end();
  }
}

export interface LockTimeoutResult {
  accountId: number;
  lockTimeoutMs: number;
  errorCode: string | undefined;
  errorMessage: string | undefined;
  elapsedMs: number;
  abortedAfterTimeout: boolean;
  locksWhileBWaiting: LockSnapshotRow[];
}

/**
 * `SET LOCAL lock_timeout = '...'` bounds how long a statement will wait to
 * acquire ANY lock (not just row locks) before Postgres cancels it. Unlike
 * NOWAIT (fail instantly, never wait), this lets a transaction wait up to a
 * caller-chosen budget, then gives up instead of waiting indefinitely.
 *
 * `SET LOCAL` scopes the setting to the current transaction only - it resets
 * automatically at COMMIT/ROLLBACK, so it never leaks into a pooled
 * connection's next transaction.
 *
 * The real error Postgres raises (confirmed against a running instance):
 * SQLSTATE `55P03` (`lock_not_available`), message
 * `canceling statement due to lock timeout` - the SAME SQLSTATE as NOWAIT
 * (both are "lock not available" failures), but a DIFFERENT message, and
 * critically a real elapsed wait of roughly `lock_timeout` before it fires.
 */
export async function runLockTimeout(
  connectionString: string,
  lockTimeoutMs: number = LOCK_TIMEOUT_MS,
): Promise<LockTimeoutResult> {
  const { id: accountId } = await resetAccountBalance(connectionString, ACCOUNT_NAME, BASELINE_BALANCE_CENTS);

  const txA = await connectClient(connectionString);
  const txB = await connectClient(connectionString);
  const observer = await connectClient(connectionString);

  try {
    await txA.client.query("BEGIN");
    await readBalanceWithLock(txA.client, accountId, "FOR UPDATE");
    log.info({ accountId }, "transaction A: SELECT ... FOR UPDATE - holds the row lock, stays open");

    await txB.client.query("BEGIN");
    await txB.client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
    log.info({ accountId, lockTimeoutMs }, "transaction B: SET LOCAL lock_timeout, then SELECT ... FOR UPDATE");

    const startedAt = Date.now();
    const bSelectPromise = readBalanceWithLock(txB.client, accountId, "FOR UPDATE").then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    await sleep(Math.min(200, Math.floor(lockTimeoutMs / 2)));
    const locksWhileBWaiting = await snapshotLocks(observer.client, [txA.pid, txB.pid]);
    log.info({ accountId, locksWhileBWaiting }, "pg_locks snapshot while B is waiting inside its lock_timeout budget");

    const outcome = await bSelectPromise;
    const elapsedMs = Date.now() - startedAt;

    let errorCode: string | undefined;
    let errorMessage: string | undefined;
    if (!outcome.ok && isPgError(outcome.error)) {
      errorCode = outcome.error.code;
      errorMessage = outcome.error.message;
    }
    log.info({ accountId, ok: outcome.ok, errorCode, errorMessage, elapsedMs }, "transaction B: outcome after lock_timeout window");

    await txB.client.query("ROLLBACK");
    await txA.client.query("ROLLBACK");

    return {
      accountId,
      lockTimeoutMs,
      errorCode,
      errorMessage,
      elapsedMs,
      abortedAfterTimeout: !outcome.ok && elapsedMs >= lockTimeoutMs,
      locksWhileBWaiting,
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

  const nowaitResult = await runNowait(connectionString);
  log.warn(
    { ...nowaitResult },
    nowaitResult.errorCode === "55P03"
      ? `NOWAIT confirmed: immediate SQLSTATE 55P03 after ${nowaitResult.elapsedMs}ms (no waiting)`
      : "UNEXPECTED: NOWAIT did not raise SQLSTATE 55P03 as documented",
  );

  const lockTimeoutResult = await runLockTimeout(connectionString);
  log.warn(
    { ...lockTimeoutResult },
    lockTimeoutResult.abortedAfterTimeout
      ? `lock_timeout confirmed: aborted after ${lockTimeoutResult.elapsedMs}ms (budget was ${lockTimeoutResult.lockTimeoutMs}ms) with SQLSTATE ${lockTimeoutResult.errorCode}`
      : "UNEXPECTED: lock_timeout did not abort the blocked statement as documented",
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "nowait-and-lock-timeout scenario failed");
    process.exit(1);
  });
}
