import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { SCENARIO_ACCOUNTS } from "../seed/scenario-accounts.js";
import { connectClient, getAccountIdByName, resetAccountBalanceByName, readBalance } from "../lib/support.js";
import { createTwoPartyBarrier } from "../lib/sync.js";
import { planLeg, runLegSingleAttempt, type LegOutcome } from "../lib/transfer.js";
import { waitUntilWaitingOnLock, snapshotBlockedQueryEdges, isTwoCycleBetween, type BlockedQueryEdge } from "../lib/diagnostics.js";

const log = createLogger("lab32:scenario:deadlock");

const ACCOUNT_A_NAME = SCENARIO_ACCOUNTS[0].ownerName;
const ACCOUNT_B_NAME = SCENARIO_ACCOUNTS[1].ownerName;
const BASELINE_BALANCE_CENTS = SCENARIO_ACCOUNTS[0].balanceCents;
const TRANSFER_A_TO_B_CENTS = 25_000; // Tx A: transfer A -> B, so it locks A first, then requests B
const TRANSFER_B_TO_A_CENTS = 40_000; // Tx B: transfer B -> A, so it locks B first, then requests A

export interface ReproduceDeadlockResult {
  accountAId: number;
  accountBId: number;
  outcomeA: LegOutcome;
  outcomeB: LegOutcome;
  /** True iff exactly one leg committed and the other was aborted with a
   * real SQLSTATE 40P01 - the deadlock actually happened and Postgres
   * actually resolved it, every run, not "most" runs. */
  deadlockReproduced: boolean;
  /** The `pg_locks`/`pg_stat_activity` snapshot captured WHILE both
   * transactions were genuinely, simultaneously blocked - i.e. the real
   * wait-for cycle, caught before Postgres's own detector broke it. */
  diagnosticEdges: BlockedQueryEdge[];
  cycleObserved: boolean;
  finalBalanceAccountA: number;
  finalBalanceAccountB: number;
}

/**
 * THE BUG: two transfers between the same two accounts, in OPPOSITE
 * directions, each written the "naive" way - lock the account you're
 * debiting FIRST, then the one you're crediting.
 *
 * Tx A: transfer(A -> B) locks A, then requests B.
 * Tx B: transfer(B -> A) locks B, then requests A.
 *
 * An explicit two-party rendezvous (`createTwoPartyBarrier`, not a sleep)
 * forces both transactions to have ALREADY taken their first lock before
 * either one requests its second - so both requests for the OTHER row are
 * guaranteed to be in flight at the same time, every single run. That is a
 * real wait-for cycle: A holds A, waiting for B; B holds B, waiting for A.
 * Postgres's own deadlock detector (not this script) notices the cycle after
 * `deadlock_timeout` and aborts ONE of the two transactions with a real,
 * captured SQLSTATE 40P01 - the other proceeds and commits normally.
 */
export async function reproduceDeadlock(connectionString: string): Promise<ReproduceDeadlockResult> {
  await resetAccountBalanceByName(connectionString, ACCOUNT_A_NAME, BASELINE_BALANCE_CENTS);
  await resetAccountBalanceByName(connectionString, ACCOUNT_B_NAME, BASELINE_BALANCE_CENTS);
  const accountAId = await getAccountIdByName(connectionString, ACCOUNT_A_NAME);
  const accountBId = await getAccountIdByName(connectionString, ACCOUNT_B_NAME);

  const txA = await connectClient(connectionString);
  const txB = await connectClient(connectionString);
  const observer = await connectClient(connectionString);

  try {
    const barrier = createTwoPartyBarrier();
    const planA = planLeg("naive-lock-order", "A", accountAId, accountBId, TRANSFER_A_TO_B_CENTS);
    const planB = planLeg("naive-lock-order", "B", accountBId, accountAId, TRANSFER_B_TO_A_CENTS);

    log.info({ planA, planB }, "starting both legs - each locks ITS OWN 'from' account first, opposite lock order");

    const outcomeAPromise = runLegSingleAttempt(txA.client, planA, barrier);
    const outcomeBPromise = runLegSingleAttempt(txB.client, planB, barrier);

    const [aIsWaiting, bIsWaiting] = await Promise.all([
      waitUntilWaitingOnLock(observer.client, txA.pid),
      waitUntilWaitingOnLock(observer.client, txB.pid),
    ]);

    let diagnosticEdges: BlockedQueryEdge[] = [];
    let cycleObserved = false;
    if (aIsWaiting && bIsWaiting) {
      diagnosticEdges = await snapshotBlockedQueryEdges(observer.client, [txA.pid, txB.pid]);
      cycleObserved = isTwoCycleBetween(diagnosticEdges, txA.pid, txB.pid);
      log.warn(
        { diagnosticEdges, cycleObserved },
        "DIAGNOSTIC: pg_locks + pg_stat_activity snapshot captured WHILE both transactions are genuinely blocked - this is the real wait-for cycle, taken before Postgres's own detector resolves it",
      );
    } else {
      log.warn({ aIsWaiting, bIsWaiting }, "did not observe both sides waiting on a lock in time - see README if this happens repeatedly");
    }

    const [outcomeA, outcomeB] = await Promise.all([outcomeAPromise, outcomeBPromise]);

    for (const outcome of [outcomeA, outcomeB]) {
      if (outcome.status === "deadlock_aborted") {
        log.error(
          { workerLabel: outcome.workerLabel, sqlstate: outcome.sqlstate, message: outcome.message, detail: outcome.detail, hint: outcome.hint },
          "REAL, CAPTURED Postgres deadlock victim - this is Postgres's own error, not simulated",
        );
      } else {
        log.info({ workerLabel: outcome.workerLabel, status: outcome.status }, "transaction leg outcome");
      }
    }

    const finalBalanceAccountA = await readBalance(observer.client, accountAId);
    const finalBalanceAccountB = await readBalance(observer.client, accountBId);

    const deadlockReproduced =
      (outcomeA.status === "deadlock_aborted" && outcomeB.status === "committed") ||
      (outcomeB.status === "deadlock_aborted" && outcomeA.status === "committed");

    return {
      accountAId,
      accountBId,
      outcomeA,
      outcomeB,
      deadlockReproduced,
      diagnosticEdges,
      cycleObserved,
      finalBalanceAccountA,
      finalBalanceAccountB,
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

  const result = await reproduceDeadlock(connectionString);

  log.warn(
    { ...result },
    result.deadlockReproduced
      ? "REAL DEADLOCK REPRODUCED: exactly one leg was aborted with SQLSTATE 40P01, the other committed"
      : "UNEXPECTED: no deadlock occurred - see README 'Break it' for why this could happen and how to investigate",
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "reproduce-deadlock scenario failed");
    process.exit(1);
  });
}
