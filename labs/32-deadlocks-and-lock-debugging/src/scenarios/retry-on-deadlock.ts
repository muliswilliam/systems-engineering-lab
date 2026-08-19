import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { SCENARIO_ACCOUNTS } from "../seed/scenario-accounts.js";
import { connectClient, getAccountIdByName, resetAccountBalanceByName, readBalance } from "../lib/support.js";
import { createTwoPartyBarrier } from "../lib/sync.js";
import { planLeg, runLegWithRetry, type LegOutcome } from "../lib/transfer.js";

const log = createLogger("lab32:scenario:retry");

const ACCOUNT_A_NAME = SCENARIO_ACCOUNTS[0].ownerName;
const ACCOUNT_B_NAME = SCENARIO_ACCOUNTS[1].ownerName;
const BASELINE_BALANCE_CENTS = SCENARIO_ACCOUNTS[0].balanceCents;
const TRANSFER_A_TO_B_CENTS = 25_000;
const TRANSFER_B_TO_A_CENTS = 40_000;
const MAX_ATTEMPTS = 5;

export interface RetryOnDeadlockResult {
  accountAId: number;
  accountBId: number;
  outcomeA: LegOutcome;
  outcomeB: LegOutcome;
  bothEventuallyCommitted: boolean;
  totalDeadlocksObserved: number;
  finalBalanceAccountA: number;
  finalBalanceAccountB: number;
  expectedBalanceAccountA: number;
  expectedBalanceAccountB: number;
}

/**
 * THE COMPLEMENTARY (NOT EQUIVALENT) MITIGATION: same naive lock order as
 * reproduce-deadlock.ts - this deliberately still forms a real deadlock on
 * attempt 1 - but each leg is wrapped in `runLegWithRetry`, which catches a
 * SQLSTATE 40P01, backs off a short randomized interval, and retries as an
 * ordinary transaction.
 *
 * IMPORTANT: this RECOVERS from the deadlock after the fact. It does nothing
 * to stop the cycle from forming - the first attempt still deadlocks, still
 * costs a full `deadlock_timeout` wait, still aborts a whole transaction and
 * discards its work. `consistent-lock-ordering.ts` PREVENTS the cycle from
 * forming in the first place. Both approaches end with all transfers
 * eventually applied, but only one of them avoids paying the deadlock cost
 * at all. See this lab's README "Fix it" for the full comparison, including
 * why this is NOT the same retry mechanism Lab 09 teaches for Serializable
 * (SSI) conflicts.
 */
export async function runRetryOnDeadlock(connectionString: string): Promise<RetryOnDeadlockResult> {
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

    log.info({ planA, planB, maxAttempts: MAX_ATTEMPTS }, "starting both legs with naive lock order AND retry-on-deadlock");

    const [outcomeA, outcomeB] = await Promise.all([
      runLegWithRetry(txA.client, planA, { rendezvousForFirstAttempt: barrier, maxAttempts: MAX_ATTEMPTS, log }),
      runLegWithRetry(txB.client, planB, { rendezvousForFirstAttempt: barrier, maxAttempts: MAX_ATTEMPTS, log }),
    ]);

    const totalDeadlocksObserved = (outcomeA.attempts - 1) + (outcomeB.attempts - 1);

    for (const outcome of [outcomeA, outcomeB]) {
      log.info(
        { workerLabel: outcome.workerLabel, status: outcome.status, attempts: outcome.attempts },
        outcome.attempts > 1
          ? "this leg was a real deadlock victim on an earlier attempt, then succeeded on retry"
          : "this leg committed on its first attempt",
      );
    }

    const finalBalanceAccountA = await readBalance(observer.client, accountAId);
    const finalBalanceAccountB = await readBalance(observer.client, accountBId);
    const expectedBalanceAccountA = BASELINE_BALANCE_CENTS - TRANSFER_A_TO_B_CENTS + TRANSFER_B_TO_A_CENTS;
    const expectedBalanceAccountB = BASELINE_BALANCE_CENTS - TRANSFER_B_TO_A_CENTS + TRANSFER_A_TO_B_CENTS;

    return {
      accountAId,
      accountBId,
      outcomeA,
      outcomeB,
      bothEventuallyCommitted: outcomeA.status === "committed" && outcomeB.status === "committed",
      totalDeadlocksObserved,
      finalBalanceAccountA,
      finalBalanceAccountB,
      expectedBalanceAccountA,
      expectedBalanceAccountB,
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

  const result = await runRetryOnDeadlock(connectionString);

  log.warn(
    { ...result },
    result.bothEventuallyCommitted
      ? `RECOVERED: both legs eventually committed after ${result.totalDeadlocksObserved} real deadlock(s) - contrast this cost against consistent-lock-ordering.ts's zero deadlocks for the identical scenario`
      : "UNEXPECTED: a leg did not eventually commit within its retry budget",
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "retry-on-deadlock scenario failed");
    process.exit(1);
  });
}
