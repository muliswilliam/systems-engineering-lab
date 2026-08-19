import "dotenv/config";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { createLogger } from "@labs/logging";
import { SCENARIO_ACCOUNTS } from "../seed/scenario-accounts.js";
import { connectClient, readBalanceWithLock, resetAccountBalance, sleep } from "./support.js";

const log = createLogger("lab10:scenario:lock-modes");

const ACCOUNT_NAME = "Scenario Account - Lock Modes";
const BASELINE_BALANCE_CENTS = SCENARIO_ACCOUNTS.find((a) => a.ownerName === ACCOUNT_NAME)!.balanceCents;

async function timeIt<T>(fn: () => Promise<T>): Promise<{ result: T; elapsedMs: number }> {
  const startedAt = Date.now();
  const result = await fn();
  return { result, elapsedMs: Date.now() - startedAt };
}

export interface ForShareConcurrentResult {
  accountId: number;
  aElapsedMs: number;
  bElapsedMs: number;
  bothAcquiredWithoutBlocking: boolean;
  writerBlockedMs: number;
  writerWaitedForBothReaders: boolean;
}

/**
 * DEMO 1: `FOR SHARE` readers do not block each other.
 *
 * Two transactions both take `SELECT ... FOR SHARE` on the same row. Neither
 * blocks the other - `FOR SHARE` is a shared lock, exactly like a shared
 * (read) lock in any lock-based concurrency system: many readers can hold it
 * at once. Then a third transaction attempts a plain `UPDATE` on the same
 * row - THAT blocks, and does not unblock until BOTH `FOR SHARE` holders
 * release (commit/rollback), one at a time.
 */
async function demoForShareConcurrentReaders(connectionString: string): Promise<ForShareConcurrentResult> {
  const { id: accountId } = await resetAccountBalance(connectionString, ACCOUNT_NAME, BASELINE_BALANCE_CENTS);

  const txA = await connectClient(connectionString);
  const txB = await connectClient(connectionString);
  const txWriter = await connectClient(connectionString);

  try {
    await txA.client.query("BEGIN");
    await txB.client.query("BEGIN");

    const { elapsedMs: aElapsedMs } = await timeIt(() => readBalanceWithLock(txA.client, accountId, "FOR SHARE"));
    log.info({ accountId, aElapsedMs }, "transaction A: SELECT ... FOR SHARE acquired");

    const { elapsedMs: bElapsedMs } = await timeIt(() => readBalanceWithLock(txB.client, accountId, "FOR SHARE"));
    log.info(
      { accountId, bElapsedMs },
      "transaction B: SELECT ... FOR SHARE ALSO acquired concurrently - no blocking between two FOR SHARE holders",
    );

    await txWriter.client.query("BEGIN");
    const writerStartedAt = Date.now();
    const writerPromise = txWriter.client
      .query("UPDATE accounts SET balance_cents = balance_cents - 1 WHERE id = $1", [accountId])
      .then(() => Date.now() - writerStartedAt);
    log.info({ accountId }, "writer: plain UPDATE issued - blocks until BOTH FOR SHARE holders release");

    await sleep(200);
    // A releases; writer must still be blocked because B still holds FOR SHARE.
    await txA.client.query("COMMIT");
    log.info({ accountId }, "transaction A: COMMIT (released FOR SHARE) - writer should still be blocked by B");

    await sleep(200);
    let writerBlockedMs: number | undefined;
    const raceCheck = await Promise.race([
      writerPromise.then((ms) => ({ done: true as const, ms })),
      sleep(0).then(() => ({ done: false as const, ms: undefined })),
    ]);
    const stillBlockedAfterAReleased = !raceCheck.done;

    await txB.client.query("COMMIT");
    log.info({ accountId }, "transaction B: COMMIT (released FOR SHARE) - writer should unblock now");

    writerBlockedMs = await writerPromise;
    log.info({ accountId, writerBlockedMs, stillBlockedAfterAReleased }, "writer: UPDATE unblocked");

    await txWriter.client.query("COMMIT");

    return {
      accountId,
      aElapsedMs,
      bElapsedMs,
      bothAcquiredWithoutBlocking: aElapsedMs < 100 && bElapsedMs < 100,
      writerBlockedMs,
      writerWaitedForBothReaders: stillBlockedAfterAReleased,
    };
  } finally {
    await txA.client.end();
    await txB.client.end();
    await txWriter.client.end();
  }
}

export interface ForUpdateBlocksForShareResult {
  accountId: number;
  forShareBlockedMs: number;
  forShareBlockedOnForUpdate: boolean;
}

/**
 * DEMO 2: `FOR UPDATE` blocks a subsequent `FOR SHARE`.
 *
 * `FOR UPDATE` is an exclusive row lock - it conflicts with everything,
 * including another reader's `FOR SHARE`. This is the asymmetry that makes
 * `FOR SHARE` correct for "I'm about to reference this row and need it to
 * not disappear/change size, but I don't need to be the only reader."
 */
async function demoForUpdateBlocksForShare(connectionString: string): Promise<ForUpdateBlocksForShareResult> {
  const { id: accountId } = await resetAccountBalance(connectionString, ACCOUNT_NAME, BASELINE_BALANCE_CENTS);

  const txA = await connectClient(connectionString);
  const txB = await connectClient(connectionString);

  try {
    await txA.client.query("BEGIN");
    await readBalanceWithLock(txA.client, accountId, "FOR UPDATE");
    log.info({ accountId }, "transaction A: SELECT ... FOR UPDATE acquired (exclusive)");

    await txB.client.query("BEGIN");
    const startedAt = Date.now();
    const bPromise = readBalanceWithLock(txB.client, accountId, "FOR SHARE").then(() => Date.now() - startedAt);
    log.info({ accountId }, "transaction B: SELECT ... FOR SHARE issued - blocks against A's FOR UPDATE");

    await sleep(250);
    await txA.client.query("COMMIT");
    log.info({ accountId }, "transaction A: COMMIT - releases FOR UPDATE");

    const forShareBlockedMs = await bPromise;
    log.info({ accountId, forShareBlockedMs }, "transaction B: FOR SHARE unblocked");

    await txB.client.query("COMMIT");

    return { accountId, forShareBlockedMs, forShareBlockedOnForUpdate: forShareBlockedMs >= 200 };
  } finally {
    await txA.client.end();
    await txB.client.end();
  }
}

export interface KeyShareVsNoKeyUpdateResult {
  accountId: number;
  /** Plain UPDATE of a non-unique, non-key column (owner_name). Postgres
   * documents that such an UPDATE only takes a `FOR NO KEY UPDATE` tuple
   * lock, because it cannot change what a foreign key elsewhere might be
   * referencing. */
  keyShareAgainstNonKeyUpdateBlockedMs: number;
  keyShareAgainstNonKeyUpdateBlocked: boolean;
  /** Plain UPDATE of the row's UNIQUE `public_id` column. Postgres documents
   * that an UPDATE modifying a column covered by a unique index (a column
   * that COULD be a foreign key's target) takes the full `FOR UPDATE`
   * strength instead. */
  keyShareAgainstKeyUpdateBlockedMs: number;
  keyShareAgainstKeyUpdateBlocked: boolean;
}

/**
 * DEMO 3: why an ordinary `UPDATE` does not always conflict with a
 * `FOR KEY SHARE` lock (the lock Postgres takes internally to check a
 * foreign key reference).
 *
 * Per the Postgres row-level lock compatibility table (docs section
 * "Explicit Locking" > "Row-level Locks"), `FOR KEY SHARE` conflicts ONLY
 * with `FOR UPDATE` - it does NOT conflict with `FOR NO KEY UPDATE`. An
 * ordinary `UPDATE` statement chooses its own tuple-lock strength based on
 * whether it touches any column that is part of a unique index (i.e. a
 * column a foreign key elsewhere COULD reference): if it does not, Postgres
 * takes the weaker `FOR NO KEY UPDATE`; if it does, Postgres takes the full
 * `FOR UPDATE`.
 *
 * This is verified directly below against a real running Postgres instance
 * rather than assumed from memory: updating `owner_name` (not part of any
 * unique index on this table) does not block a concurrent `FOR KEY SHARE`;
 * updating `public_id` (which IS unique) does.
 */
async function demoKeyShareVsNoKeyUpdate(connectionString: string): Promise<KeyShareVsNoKeyUpdateResult> {
  const { id: accountId } = await resetAccountBalance(connectionString, ACCOUNT_NAME, BASELINE_BALANCE_CENTS);

  // --- Part 1: UPDATE of a non-key column (owner_name) -----------------
  const nonKeyTx = await connectClient(connectionString);
  const keyShareTx1 = await connectClient(connectionString);
  let keyShareAgainstNonKeyUpdateBlockedMs: number;
  try {
    await nonKeyTx.client.query("BEGIN");
    await nonKeyTx.client.query("UPDATE accounts SET owner_name = owner_name || ' (touched)' WHERE id = $1", [
      accountId,
    ]);
    log.info(
      { accountId },
      "transaction NON-KEY: UPDATE owner_name (not part of any unique index) - should take FOR NO KEY UPDATE",
    );

    await keyShareTx1.client.query("BEGIN");
    const startedAt = Date.now();
    await readBalanceWithLock(keyShareTx1.client, accountId, "FOR KEY SHARE");
    keyShareAgainstNonKeyUpdateBlockedMs = Date.now() - startedAt;
    log.info(
      { accountId, keyShareAgainstNonKeyUpdateBlockedMs },
      "transaction KEY-SHARE: FOR KEY SHARE result against an open non-key UPDATE",
    );

    await keyShareTx1.client.query("COMMIT");
    await nonKeyTx.client.query("ROLLBACK"); // don't actually rename the scenario account
  } finally {
    await nonKeyTx.client.end();
    await keyShareTx1.client.end();
  }

  // --- Part 2: UPDATE of a unique column (public_id) --------------------
  const keyTx = await connectClient(connectionString);
  const keyShareTx2 = await connectClient(connectionString);
  let keyShareAgainstKeyUpdateBlockedMs: number;
  try {
    await keyTx.client.query("BEGIN");
    await keyTx.client.query("UPDATE accounts SET public_id = gen_random_uuid() WHERE id = $1", [accountId]);
    log.info({ accountId }, "transaction KEY: UPDATE public_id (UNIQUE column) - should take full FOR UPDATE");

    await keyShareTx2.client.query("BEGIN");
    const startedAt = Date.now();
    const keyShareResultPromise = readBalanceWithLock(keyShareTx2.client, accountId, "FOR KEY SHARE").then(
      () => Date.now() - startedAt,
    );

    await sleep(250);
    await keyTx.client.query("ROLLBACK"); // don't actually change the scenario account's public_id
    log.info({ accountId }, "transaction KEY: ROLLBACK - releases the lock");

    keyShareAgainstKeyUpdateBlockedMs = await keyShareResultPromise;
    log.info(
      { accountId, keyShareAgainstKeyUpdateBlockedMs },
      "transaction KEY-SHARE: FOR KEY SHARE unblocked only after the key-column UPDATE released",
    );

    await keyShareTx2.client.query("COMMIT");
  } finally {
    await keyTx.client.end();
    await keyShareTx2.client.end();
  }

  return {
    accountId,
    keyShareAgainstNonKeyUpdateBlockedMs,
    keyShareAgainstNonKeyUpdateBlocked: keyShareAgainstNonKeyUpdateBlockedMs >= 200,
    keyShareAgainstKeyUpdateBlockedMs,
    keyShareAgainstKeyUpdateBlocked: keyShareAgainstKeyUpdateBlockedMs >= 200,
  };
}

export interface LockModesResult {
  forShareConcurrent: ForShareConcurrentResult;
  forUpdateBlocksForShare: ForUpdateBlocksForShareResult;
  keyShareVsNoKeyUpdate: KeyShareVsNoKeyUpdateResult;
}

export async function runLockModes(connectionString: string): Promise<LockModesResult> {
  const forShareConcurrent = await demoForShareConcurrentReaders(connectionString);
  const forUpdateBlocksForShare = await demoForUpdateBlocksForShare(connectionString);
  const keyShareVsNoKeyUpdate = await demoKeyShareVsNoKeyUpdate(connectionString);
  return { forShareConcurrent, forUpdateBlocksForShare, keyShareVsNoKeyUpdate };
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }

  const result = await runLockModes(connectionString);
  log.warn({ ...result }, "lock-modes demo complete - see README.md 'Observe' for how to read each field");
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "lock-modes scenario failed");
    process.exit(1);
  });
}

// Re-exported so tests can import the pg Client type without duplicating it.
export type { Client };
