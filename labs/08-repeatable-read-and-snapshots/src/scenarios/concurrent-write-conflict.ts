import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { SCENARIO_ACCOUNTS } from "../seed/scenario-data.js";
import {
  beginWithIsolation,
  connectClient,
  getErrorMessage,
  getPgErrorCode,
  isSerializationFailure,
  readBalance,
  resetAccountBalance,
} from "./support.js";

const log = createLogger("lab08:scenario:concurrent-write-conflict");

const ACCOUNT_NAME = "Scenario Account - Concurrent Write Conflict";
const BASELINE_BALANCE_CENTS = SCENARIO_ACCOUNTS.find((a) => a.name === ACCOUNT_NAME)!.balanceCents;
const A_CREDIT_CENTS = 10_000;
const B_DEBIT_CENTS = 7_500;

export interface ConcurrentWriteConflictResult {
  accountId: number;
  baselineBalanceCents: number;
  aRead: number;
  bRead: number;
  aNewBalance: number;
  bAttemptedNewBalance: number;
  aCommitted: boolean;
  bFailed: boolean;
  bErrorCode: string | undefined;
  bErrorMessage: string | undefined;
  bSawSerializationFailure: boolean;
  finalBalanceCents: number;
  finalBalanceMatchesA: boolean;
}

/**
 * Two REPEATABLE READ transactions both read the same row from their own
 * snapshot, then both try to UPDATE it based on the value they read - the
 * classic naive read-modify-write race. Under REPEATABLE READ, Postgres does
 * NOT let the second committer silently overwrite the first committer's
 * change with a computation based on stale data. Instead, whichever
 * transaction's UPDATE targets a row that has already been changed by
 * another transaction that committed after its own snapshot began gets
 * rolled back with:
 *
 *   ERROR: could not serialize access due to concurrent update
 *   SQLSTATE 40001
 *
 * This scenario intentionally sequences A's UPDATE + COMMIT to complete
 * before B's UPDATE is issued - the race isn't in the UPDATE statements
 * themselves, it's in the two SELECTs both being taken from snapshots that
 * predate either write. That overlap alone is what makes B's later UPDATE
 * conflict: Postgres checks "has this row changed since MY transaction's
 * snapshot began?", not "is anyone currently blocking me?". A slower-paced,
 * fully sequential UPDATE ordering reproduces the exact same 40001 failure
 * as truly simultaneous UPDATEs would, without the flakiness of racing two
 * promises against each other in a test suite.
 */
export async function runConcurrentWriteConflict(
  connectionString: string,
  options: { accountName?: string; baselineBalanceCents?: number } = {},
): Promise<ConcurrentWriteConflictResult> {
  const accountName = options.accountName ?? ACCOUNT_NAME;
  const baselineBalanceCents = options.baselineBalanceCents ?? BASELINE_BALANCE_CENTS;

  const { id: accountId } = await resetAccountBalance(connectionString, accountName, baselineBalanceCents);

  const txA = await connectClient(connectionString);
  const txB = await connectClient(connectionString);

  try {
    await beginWithIsolation(txA, "REPEATABLE READ");
    await beginWithIsolation(txB, "REPEATABLE READ");

    const aRead = await readBalance(txA, accountId);
    const bRead = await readBalance(txB, accountId);
    log.info({ accountId, aRead, bRead }, "both transactions read the same baseline from their own snapshot");

    const aNewBalance = aRead + A_CREDIT_CENTS;
    const bAttemptedNewBalance = bRead - B_DEBIT_CENTS;

    await txA.query("UPDATE accounts SET balance_cents = $1 WHERE id = $2", [aNewBalance, accountId]);
    await txA.query("COMMIT");
    log.info({ accountId, aNewBalance }, "transaction A: UPDATE + COMMIT succeeded");

    let bFailed = false;
    let bErrorCode: string | undefined;
    let bErrorMessage: string | undefined;
    let bSawSerializationFailure = false;

    try {
      await txB.query("UPDATE accounts SET balance_cents = $1 WHERE id = $2", [bAttemptedNewBalance, accountId]);
      await txB.query("COMMIT");
      log.warn({ accountId }, "UNEXPECTED: transaction B's UPDATE succeeded - expected a 40001 serialization failure");
    } catch (error) {
      bFailed = true;
      bErrorCode = getPgErrorCode(error);
      bErrorMessage = getErrorMessage(error);
      bSawSerializationFailure = isSerializationFailure(error);
      await txB.query("ROLLBACK");
      log.info(
        { accountId, bErrorCode, bErrorMessage },
        "transaction B: UPDATE failed as expected - Postgres detected the concurrent update instead of silently applying a lost update",
      );
    }

    const verifyClient = await connectClient(connectionString);
    let finalBalanceCents: number;
    try {
      finalBalanceCents = await readBalance(verifyClient, accountId);
    } finally {
      await verifyClient.end();
    }

    return {
      accountId,
      baselineBalanceCents,
      aRead,
      bRead,
      aNewBalance,
      bAttemptedNewBalance,
      aCommitted: true,
      bFailed,
      bErrorCode,
      bErrorMessage,
      bSawSerializationFailure,
      finalBalanceCents,
      finalBalanceMatchesA: finalBalanceCents === aNewBalance,
    };
  } finally {
    await txA.end();
    await txB.end();
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }

  const result = await runConcurrentWriteConflict(connectionString);

  log.warn(
    { ...result },
    result.bSawSerializationFailure && result.finalBalanceMatchesA
      ? "confirmed: exactly one transaction's write survived, the other was rejected with SQLSTATE 40001 rather than silently lost - the app must retry B, not assume its write applied"
      : "UNEXPECTED: did not see the expected serialization failure / final-state outcome",
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "concurrent-write-conflict scenario failed");
    process.exit(1);
  });
}
