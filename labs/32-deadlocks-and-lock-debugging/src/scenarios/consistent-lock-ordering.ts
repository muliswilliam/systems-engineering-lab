import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { SCENARIO_ACCOUNTS } from "../seed/scenario-accounts.js";
import { connectClient, getAccountIdByName, resetAccountBalanceByName, readBalance } from "../lib/support.js";
import { planLeg, runLegSingleAttempt, type LegOutcome } from "../lib/transfer.js";

const log = createLogger("lab32:scenario:ordered");

const ACCOUNT_A_NAME = SCENARIO_ACCOUNTS[0].ownerName;
const ACCOUNT_B_NAME = SCENARIO_ACCOUNTS[1].ownerName;
const BASELINE_BALANCE_CENTS = SCENARIO_ACCOUNTS[0].balanceCents;
// Deliberately asymmetric amounts (unlike a naive "both transfer $X" demo)
// so the final balances PROVE both transfers actually applied, rather than
// happening to net to the untouched baseline by coincidence.
const TRANSFER_A_TO_B_CENTS = 25_000;
const TRANSFER_B_TO_A_CENTS = 40_000;

export interface ConsistentOrderingResult {
  accountAId: number;
  accountBId: number;
  outcomeA: LegOutcome;
  outcomeB: LegOutcome;
  bothCommitted: boolean;
  neitherDeadlocked: boolean;
  /** Real wall-clock ms each leg's `runLegSingleAttempt` call took. The
   * loser's duration includes waiting for the winner's ENTIRE transaction to
   * commit (its first lock request blocks on a real row lock, not a
   * deadlock) - a genuinely different, larger number from the winner's. */
  legADurationMs: number;
  legBDurationMs: number;
  finalBalanceAccountA: number;
  finalBalanceAccountB: number;
  expectedBalanceAccountA: number;
  expectedBalanceAccountB: number;
}

/**
 * THE FIX: identical business scenario as reproduce-deadlock.ts - the SAME
 * two opposite-direction transfers between the SAME two accounts - with
 * exactly one change: `planLeg` is called with `"consistent-lock-order"`
 * instead of `"naive-lock-order"`. Both legs now agree to lock
 * `Math.min(accountAId, accountBId)` FIRST, no matter which way their own
 * transfer is moving money - which means BOTH legs' `firstLockId` is now the
 * SAME row.
 *
 * Deliberately NOT using this lab's `createTwoPartyBarrier` rendezvous here
 * (unlike reproduce-deadlock.ts). That barrier assumes both sides can
 * acquire their FIRST lock immediately and only contend on the SECOND one -
 * true for naive ordering (different first-lock rows), but false here by
 * design: with a shared first-lock row, one side's very first `SELECT ...
 * FOR UPDATE` genuinely blocks on a real Postgres row lock before it could
 * ever reach a rendezvous point. (An earlier version of this scenario
 * reused the barrier here and deadlocked at the APPLICATION level - the
 * winner waiting on the barrier for a peer that was itself stuck behind a
 * real Postgres lock the winner alone could release by committing. Real bug,
 * caught during this lab's own validation - see README "Break it".) No
 * artificial synchronization is needed for the fix to work: ordinary
 * Postgres lock contention is the entire mechanism.
 *
 * Whichever leg's `SELECT ... FOR UPDATE` on the lower id is received first
 * by Postgres becomes the only one making progress; the OTHER leg's
 * first-lock request itself blocks - genuinely, for real wall-clock time -
 * until the winner commits and releases both rows. There is no cycle: the
 * loser is waiting for a lock that is guaranteed to be released by a
 * transaction that is not, in turn, waiting on the loser for anything. Both
 * legs commit. Zero deadlocks, every run.
 */
export async function runConsistentLockOrdering(connectionString: string): Promise<ConsistentOrderingResult> {
  await resetAccountBalanceByName(connectionString, ACCOUNT_A_NAME, BASELINE_BALANCE_CENTS);
  await resetAccountBalanceByName(connectionString, ACCOUNT_B_NAME, BASELINE_BALANCE_CENTS);
  const accountAId = await getAccountIdByName(connectionString, ACCOUNT_A_NAME);
  const accountBId = await getAccountIdByName(connectionString, ACCOUNT_B_NAME);

  const txA = await connectClient(connectionString);
  const txB = await connectClient(connectionString);
  const observer = await connectClient(connectionString);

  try {
    const planA = planLeg("consistent-lock-order", "A", accountAId, accountBId, TRANSFER_A_TO_B_CENTS);
    const planB = planLeg("consistent-lock-order", "B", accountBId, accountAId, TRANSFER_B_TO_A_CENTS);

    log.info(
      { planA, planB },
      "starting both legs - BOTH now lock the lower account id first, regardless of transfer direction (no artificial synchronization needed)",
    );

    const startedAt = Date.now();
    const legAPromise = runLegSingleAttempt(txA.client, planA).then((outcome) => ({
      outcome,
      durationMs: Date.now() - startedAt,
    }));
    const legBPromise = runLegSingleAttempt(txB.client, planB).then((outcome) => ({
      outcome,
      durationMs: Date.now() - startedAt,
    }));

    const [{ outcome: outcomeA, durationMs: legADurationMs }, { outcome: outcomeB, durationMs: legBDurationMs }] =
      await Promise.all([legAPromise, legBPromise]);

    log.info(
      { outcomeA, outcomeB, legADurationMs, legBDurationMs },
      "both legs finished - one committed quickly, the other waited a real, measurable duration for an ordinary row lock, not a deadlock",
    );

    const finalBalanceAccountA = await readBalance(observer.client, accountAId);
    const finalBalanceAccountB = await readBalance(observer.client, accountBId);
    const expectedBalanceAccountA = BASELINE_BALANCE_CENTS - TRANSFER_A_TO_B_CENTS + TRANSFER_B_TO_A_CENTS;
    const expectedBalanceAccountB = BASELINE_BALANCE_CENTS - TRANSFER_B_TO_A_CENTS + TRANSFER_A_TO_B_CENTS;

    return {
      accountAId,
      accountBId,
      outcomeA,
      outcomeB,
      bothCommitted: outcomeA.status === "committed" && outcomeB.status === "committed",
      neitherDeadlocked: outcomeA.status !== "deadlock_aborted" && outcomeB.status !== "deadlock_aborted",
      legADurationMs,
      legBDurationMs,
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

  const result = await runConsistentLockOrdering(connectionString);

  log.warn(
    { ...result },
    result.bothCommitted && result.neitherDeadlocked
      ? "FIXED: both legs committed, zero deadlocks - the slower leg genuinely WAITED (real lock block), it never got aborted"
      : "UNEXPECTED: consistent lock ordering did not prevent a deadlock - this would mean the two legs are not actually agreeing on lock order",
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "consistent-lock-ordering scenario failed");
    process.exit(1);
  });
}
