import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { SCENARIO_ACCOUNTS } from "../seed/scenario-data.js";
import {
  beginWithIsolation,
  connectClient,
  readBalance,
  resetAccountBalance,
  type IsolationLevel,
} from "./support.js";

const log = createLogger("lab08:scenario:repeatable-read-snapshot");

const DEFAULT_ACCOUNT_NAME = "Scenario Account - Repeatable Read Snapshot";
const DEFAULT_BASELINE_BALANCE_CENTS = SCENARIO_ACCOUNTS.find((a) => a.name === DEFAULT_ACCOUNT_NAME)!.balanceCents;
const CREDIT_CENTS = 25_000;

export interface RepeatableReadSnapshotOptions {
  accountName?: string;
  baselineBalanceCents?: number;
  /**
   * REPEATABLE READ is this lab's subject. READ COMMITTED is accepted here
   * purely so this file's own tests can run the identical setup under both
   * levels and contrast the outcome, self-contained, without importing
   * Lab 07's code (labs are independent - CLAUDE.md 4.1).
   */
  isolationLevel?: Extract<IsolationLevel, "REPEATABLE READ" | "READ COMMITTED">;
}

export interface RepeatableReadSnapshotResult {
  accountId: number;
  accountName: string;
  requestedIsolationLevel: string;
  actualIsolationLevel: string;
  baselineBalanceCents: number;
  firstRead: number;
  committedBalanceCents: number;
  secondRead: number;
  secondReadMatchesFirstRead: boolean;
  secondReadMatchesCommittedValue: boolean;
}

/**
 * This is Lab 07's non-repeatable-read setup, replayed under REPEATABLE READ
 * instead of Read Committed: transaction A opens with REPEATABLE READ and
 * reads a row, transaction B updates AND commits that same row on an
 * independent connection, then A reads the SAME row again within the SAME
 * still-open transaction.
 *
 * Under Read Committed (Lab 07), A's second read sees B's committed change,
 * because Read Committed grants a fresh snapshot to every *statement*.
 * REPEATABLE READ instead takes ONE snapshot at the start of the
 * transaction and reuses it for every statement inside that transaction, so
 * A's second read here returns the SAME (now-stale) value as the first read
 * - B's committed update is invisible to A for the rest of A's transaction,
 * no matter how long A stays open.
 */
export async function runRepeatableReadSnapshot(
  connectionString: string,
  options: RepeatableReadSnapshotOptions = {},
): Promise<RepeatableReadSnapshotResult> {
  const accountName = options.accountName ?? DEFAULT_ACCOUNT_NAME;
  const baselineBalanceCents = options.baselineBalanceCents ?? DEFAULT_BASELINE_BALANCE_CENTS;
  const isolationLevel = options.isolationLevel ?? "REPEATABLE READ";
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
      secondReadMatchesFirstRead: secondRead === firstRead,
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

  const result = await runRepeatableReadSnapshot(connectionString);

  log.warn(
    { ...result },
    result.secondReadMatchesFirstRead
      ? "confirmed: under REPEATABLE READ, A's second read returned the SAME (stale, pre-B) value as the first read - contrast with Lab 07's READ COMMITTED, where the second read picks up B's committed change"
      : "UNEXPECTED: A's second read changed within the same REPEATABLE READ transaction - this would contradict documented Postgres semantics",
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "repeatable-read-snapshot scenario failed");
    process.exit(1);
  });
}
