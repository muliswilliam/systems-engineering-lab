import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { SCENARIO_ACCOUNTS } from "../seed/scenario-accounts.js";
import { beginWithIsolation, connectClient, readBalance, resetAccountBalance } from "./support.js";

const log = createLogger("lab07:scenario:dirty-read-attempt");

const ACCOUNT_NAME = "Scenario Account - Dirty Read";
const BASELINE_BALANCE_CENTS = SCENARIO_ACCOUNTS.find((a) => a.name === ACCOUNT_NAME)!.balanceCents;
const DEBIT_CENTS = 5_000;

export interface DirtyReadResult {
  accountId: number;
  originalBalanceCents: number;
  uncommittedBalanceCents: number;
  requestedIsolationLevel: string;
  actualIsolationLevel: string;
  balanceSeenWhileAUncommitted: number;
  balanceSeenAfterACommit: number;
  sawDirtyRead: boolean;
}

/**
 * Transaction A debits an account but does NOT commit. Transaction B opens
 * with an explicit `READ UNCOMMITTED` request and reads the same row while
 * A is still open, then again after A commits.
 *
 * The naive expectation (carried over from databases that implement true
 * READ UNCOMMITTED) is that B's first read should see A's in-flight,
 * uncommitted debit - a "dirty read". Postgres never allows this at any
 * isolation level: MVCC means a reader only ever sees committed row
 * versions, so B's first read must return the ORIGINAL balance, and only the
 * second read (after A commits) sees the debited balance.
 */
export async function runDirtyReadAttempt(connectionString: string): Promise<DirtyReadResult> {
  const { id: accountId } = await resetAccountBalance(connectionString, ACCOUNT_NAME, BASELINE_BALANCE_CENTS);
  const uncommittedBalanceCents = BASELINE_BALANCE_CENTS - DEBIT_CENTS;

  const txA = await connectClient(connectionString);
  const txB = await connectClient(connectionString);

  try {
    log.info({ accountId, originalBalanceCents: BASELINE_BALANCE_CENTS }, "transaction A: BEGIN");
    await txA.query("BEGIN");
    await txA.query("UPDATE accounts SET balance_cents = $1 WHERE id = $2", [uncommittedBalanceCents, accountId]);
    log.info(
      { accountId, uncommittedBalanceCents },
      "transaction A: debited the row but has NOT committed yet",
    );

    const { requested, actual } = await beginWithIsolation(txB, "READ UNCOMMITTED");
    log.info(
      { requestedIsolationLevel: requested, actualIsolationLevel: actual },
      "transaction B: BEGIN with an explicit READ UNCOMMITTED request",
    );

    const balanceSeenWhileAUncommitted = await readBalance(txB, accountId);
    log.info(
      { balanceSeenWhileAUncommitted, aStillUncommitted: uncommittedBalanceCents },
      "transaction B: read the row while A's debit is still uncommitted",
    );

    await txA.query("COMMIT");
    log.info({ accountId }, "transaction A: COMMIT");

    const balanceSeenAfterACommit = await readBalance(txB, accountId);
    log.info(
      { balanceSeenAfterACommit },
      "transaction B: read the row again, still inside its own open transaction, after A committed",
    );

    await txB.query("COMMIT");

    const sawDirtyRead = balanceSeenWhileAUncommitted === uncommittedBalanceCents;

    return {
      accountId,
      originalBalanceCents: BASELINE_BALANCE_CENTS,
      uncommittedBalanceCents,
      requestedIsolationLevel: requested,
      actualIsolationLevel: actual,
      balanceSeenWhileAUncommitted,
      balanceSeenAfterACommit,
      sawDirtyRead,
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

  const result = await runDirtyReadAttempt(connectionString);

  log.warn(
    { ...result },
    result.sawDirtyRead
      ? "UNEXPECTED: transaction B saw A's uncommitted write - this would be a real Postgres bug"
      : "as expected: Postgres never exposed A's uncommitted write to B, even under a requested READ UNCOMMITTED",
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "dirty-read-attempt scenario failed");
    process.exit(1);
  });
}
