import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { SCENARIO_ACCOUNTS } from "../seed/scenario-accounts.js";
import {
  beginWithIsolation,
  connectClient,
  readBalance,
  resetAccountBalance,
  type IsolationLevel,
} from "./support.js";

const log = createLogger("lab07:scenario:non-repeatable-read");

const DEFAULT_ACCOUNT_NAME = "Scenario Account - Non-Repeatable Read";
const DEFAULT_BASELINE_BALANCE_CENTS = SCENARIO_ACCOUNTS.find((a) => a.name === DEFAULT_ACCOUNT_NAME)!.balanceCents;
const CREDIT_CENTS = 25_000;

export interface NonRepeatableReadOptions {
  accountName?: string;
  baselineBalanceCents?: number;
  /**
   * Read Committed is Postgres's default and the level this lab is about.
   * READ UNCOMMITTED is accepted as a parameter here specifically so
   * read-uncommitted-vs-read-committed.ts can prove it produces byte-for-byte
   * identical behavior - see that script and the README's "Fix it" section.
   */
  isolationLevel?: Extract<IsolationLevel, "READ COMMITTED" | "READ UNCOMMITTED">;
}

export interface NonRepeatableReadResult {
  accountId: number;
  accountName: string;
  requestedIsolationLevel: string;
  actualIsolationLevel: string;
  baselineBalanceCents: number;
  firstRead: number;
  committedBalanceCents: number;
  secondRead: number;
  readsDiffer: boolean;
  secondReadMatchesCommittedValue: boolean;
}

/**
 * Transaction A (Read Committed, the default) reads a row, then transaction
 * B updates AND commits that same row, then A reads the SAME row again
 * within the SAME still-open transaction. Read Committed grants a fresh
 * snapshot to every *statement*, not once per transaction - so A's second
 * read sees B's committed change even though A never committed or restarted
 * its own transaction. That is a non-repeatable read: the same query, run
 * twice in one transaction, returned two different answers.
 */
export async function runNonRepeatableRead(
  connectionString: string,
  options: NonRepeatableReadOptions = {},
): Promise<NonRepeatableReadResult> {
  const accountName = options.accountName ?? DEFAULT_ACCOUNT_NAME;
  const baselineBalanceCents = options.baselineBalanceCents ?? DEFAULT_BASELINE_BALANCE_CENTS;
  const isolationLevel = options.isolationLevel ?? "READ COMMITTED";
  const committedBalanceCents = baselineBalanceCents + CREDIT_CENTS;

  const { id: accountId } = await resetAccountBalance(connectionString, accountName, baselineBalanceCents);

  const txA = await connectClient(connectionString);
  const txB = await connectClient(connectionString);

  try {
    const { requested, actual } = await beginWithIsolation(txA, isolationLevel);
    log.info(
      { accountId, requestedIsolationLevel: requested, actualIsolationLevel: actual },
      "transaction A: BEGIN",
    );

    const firstRead = await readBalance(txA, accountId);
    log.info({ accountId, firstRead }, "transaction A: first read");

    log.info({ accountId, committedBalanceCents }, "transaction B: BEGIN, UPDATE, COMMIT (independent connection)");
    await txB.query("BEGIN");
    await txB.query("UPDATE accounts SET balance_cents = $1 WHERE id = $2", [committedBalanceCents, accountId]);
    await txB.query("COMMIT");

    const secondRead = await readBalance(txA, accountId);
    log.info(
      { accountId, secondRead },
      "transaction A: second read - SAME query, SAME still-open transaction",
    );

    await txA.query("COMMIT");

    return {
      accountId,
      accountName,
      requestedIsolationLevel: requested,
      actualIsolationLevel: actual,
      baselineBalanceCents,
      firstRead,
      committedBalanceCents,
      secondRead,
      readsDiffer: firstRead !== secondRead,
      secondReadMatchesCommittedValue: secondRead === committedBalanceCents,
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

  const result = await runNonRepeatableRead(connectionString);

  log.warn(
    { ...result },
    result.readsDiffer
      ? "non-repeatable read confirmed: A's two reads of the same row, in the same transaction, returned different values"
      : "UNEXPECTED: A's two reads returned the same value - this would mean Read Committed is not behaving as documented",
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "non-repeatable-read scenario failed");
    process.exit(1);
  });
}
