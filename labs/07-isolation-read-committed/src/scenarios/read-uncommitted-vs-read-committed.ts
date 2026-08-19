import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { SCENARIO_ACCOUNTS } from "../seed/scenario-accounts.js";
import { runNonRepeatableRead } from "./non-repeatable-read.js";

const log = createLogger("lab07:scenario:isolation-equivalence");

const ACCOUNT_NAME = "Scenario Account - Isolation Equivalence";
const BASELINE_BALANCE_CENTS = SCENARIO_ACCOUNTS.find((a) => a.name === ACCOUNT_NAME)!.balanceCents;

export interface EquivalenceResult {
  readCommitted: Awaited<ReturnType<typeof runNonRepeatableRead>>;
  readUncommitted: Awaited<ReturnType<typeof runNonRepeatableRead>>;
  behaviorIsIdentical: boolean;
}

/**
 * SQL accepts `READ UNCOMMITTED` as a transaction isolation level name -
 * Postgres does not reject it and does not warn about it. `SHOW
 * transaction_isolation` even echoes back the label you asked for
 * ("read uncommitted"), which makes it look like a real, distinct level.
 *
 * It is not. This runs the exact same non-repeatable-read experiment twice,
 * once under each requested level, and diffs the observable *behavior*: the
 * first read, the second read, and whether the two reads differ are all
 * identical between the two runs. Only the echoed label differs - Postgres
 * has no separate read-uncommitted implementation for it to select.
 */
export async function runEquivalenceDemo(connectionString: string): Promise<EquivalenceResult> {
  const readCommitted = await runNonRepeatableRead(connectionString, {
    accountName: ACCOUNT_NAME,
    baselineBalanceCents: BASELINE_BALANCE_CENTS,
    isolationLevel: "READ COMMITTED",
  });

  const readUncommitted = await runNonRepeatableRead(connectionString, {
    accountName: ACCOUNT_NAME,
    baselineBalanceCents: BASELINE_BALANCE_CENTS,
    isolationLevel: "READ UNCOMMITTED",
  });

  // Deliberately NOT comparing actualIsolationLevel here - Postgres echoes
  // back whichever label was requested (see the two "actualIsolationLevel"
  // log lines below), even though it runs identical code underneath. The
  // claim under test is about observable read behavior, not the label.
  const behaviorIsIdentical =
    readCommitted.firstRead === readUncommitted.firstRead &&
    readCommitted.secondRead === readUncommitted.secondRead &&
    readCommitted.readsDiffer === readUncommitted.readsDiffer &&
    readCommitted.secondReadMatchesCommittedValue === readUncommitted.secondReadMatchesCommittedValue;

  return { readCommitted, readUncommitted, behaviorIsIdentical };
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }

  const { readCommitted, readUncommitted, behaviorIsIdentical } = await runEquivalenceDemo(connectionString);

  log.info(
    {
      requestedIsolationLevel: readCommitted.requestedIsolationLevel,
      actualIsolationLevel: readCommitted.actualIsolationLevel,
      firstRead: readCommitted.firstRead,
      secondRead: readCommitted.secondRead,
    },
    "run 1: requested READ COMMITTED",
  );

  log.info(
    {
      requestedIsolationLevel: readUncommitted.requestedIsolationLevel,
      actualIsolationLevel: readUncommitted.actualIsolationLevel,
      firstRead: readUncommitted.firstRead,
      secondRead: readUncommitted.secondRead,
    },
    "run 2: requested READ UNCOMMITTED",
  );

  log.warn(
    {
      behaviorIsIdentical,
      actualIsolationLevelWhenReadCommittedRequested: readCommitted.actualIsolationLevel,
      actualIsolationLevelWhenReadUncommittedRequested: readUncommitted.actualIsolationLevel,
    },
    behaviorIsIdentical
      ? "confirmed: the echoed isolation-level label differs (see actualIsolationLevel above), but the observable read behavior is byte-for-byte identical - Postgres has no separate READ UNCOMMITTED implementation"
      : "UNEXPECTED: requesting READ UNCOMMITTED changed observable read behavior - this would contradict documented Postgres semantics",
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "isolation-equivalence scenario failed");
    process.exit(1);
  });
}
