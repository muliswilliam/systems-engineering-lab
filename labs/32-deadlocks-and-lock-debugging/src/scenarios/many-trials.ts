import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { pool, waitForDatabase } from "../db/client.js";
import { connectClient, resetAccountBalancesById } from "../lib/support.js";
import { createTwoPartyBarrier } from "../lib/sync.js";
import { planLeg, runLegSingleAttempt, type LegOutcome, type LockOrderStrategy } from "../lib/transfer.js";
import { getTrialPairs, type AccountPair } from "../lib/trial-pairs.js";
import { TRIAL_PAIR_BASELINE_BALANCE_CENTS } from "../seed/scenario-accounts.js";

const log = createLogger("lab32:scenario:trials");

const TRANSFER_A_TO_B_CENTS = 25_000;
const TRANSFER_B_TO_A_CENTS = 40_000;
const DEFAULT_TRIALS = 60;

export interface TrialResult {
  pairIndex: number;
  outcomeA: LegOutcome;
  outcomeB: LegOutcome;
  deadlockOccurred: boolean;
  bothCommitted: boolean;
}

async function runOneTrial(connectionString: string, pair: AccountPair, strategy: LockOrderStrategy): Promise<TrialResult> {
  const txA = await connectClient(connectionString);
  const txB = await connectClient(connectionString);
  try {
    const planA = planLeg(strategy, "A", pair.accountAId, pair.accountBId, TRANSFER_A_TO_B_CENTS);
    const planB = planLeg(strategy, "B", pair.accountBId, pair.accountAId, TRANSFER_B_TO_A_CENTS);

    // The forced-simultaneous-arrival rendezvous only makes sense (and only
    // terminates!) when both legs' FIRST lock is on a DIFFERENT row, which
    // is exactly the naive strategy's shape (each leg locks its own "from"
    // account first). Under consistent ordering both legs' first lock is
    // the SAME row by design - one side's first `SELECT ... FOR UPDATE`
    // genuinely blocks on a real Postgres lock before it could ever reach a
    // rendezvous point, so using the barrier there would deadlock this
    // SCRIPT, not Postgres. See consistent-lock-ordering.ts's doc comment
    // for the real bug this exact mistake caused during this lab's own
    // validation.
    const barrier = strategy === "naive-lock-order" ? createTwoPartyBarrier() : undefined;

    const [outcomeA, outcomeB] = await Promise.all([
      runLegSingleAttempt(txA.client, planA, barrier),
      runLegSingleAttempt(txB.client, planB, barrier),
    ]);

    const deadlockOccurred = outcomeA.status === "deadlock_aborted" || outcomeB.status === "deadlock_aborted";
    const bothCommitted = outcomeA.status === "committed" && outcomeB.status === "committed";

    return { pairIndex: pair.index, outcomeA, outcomeB, deadlockOccurred, bothCommitted };
  } finally {
    await txA.client.end();
    await txB.client.end();
  }
}

export interface ManyTrialsSummary {
  strategy: LockOrderStrategy;
  trialCount: number;
  deadlockCount: number;
  bothCommittedCount: number;
  anomalyCount: number;
  totalBalanceBeforeCents: number;
  totalBalanceAfterCents: number;
  balanceConserved: boolean;
}

/**
 * Runs `pairs.length` INDEPENDENT trials concurrently - each pair is its own
 * pair of accounts, so trials never interfere with each other, but every
 * trial still races its own two legs against each other via a fresh
 * `createTwoPartyBarrier`. This is the "N concurrent trials -> exactly X
 * deadlocks" invariant CLAUDE.md's "Transactions and Concurrency" section
 * asks for, instead of a single anecdotal run.
 */
export async function runManyTrials(
  connectionString: string,
  pairs: AccountPair[],
  strategy: LockOrderStrategy,
): Promise<{ summary: ManyTrialsSummary; results: TrialResult[] }> {
  const allAccountIds = pairs.flatMap((p) => [p.accountAId, p.accountBId]);
  await resetAccountBalancesById(pool, allAccountIds, TRIAL_PAIR_BASELINE_BALANCE_CENTS);
  const totalBalanceBeforeCents = allAccountIds.length * TRIAL_PAIR_BASELINE_BALANCE_CENTS;

  const results = await Promise.all(pairs.map((pair) => runOneTrial(connectionString, pair, strategy)));

  const deadlockCount = results.filter((r) => r.deadlockOccurred).length;
  const bothCommittedCount = results.filter((r) => r.bothCommitted).length;
  const anomalyCount = results.length - deadlockCount - bothCommittedCount;

  const { rows } = await pool.query<{ total: string }>(
    "SELECT coalesce(sum(balance_cents), 0)::text AS total FROM accounts WHERE id = ANY($1::bigint[])",
    [allAccountIds],
  );
  const totalBalanceAfterCents = Number(rows[0]?.total ?? 0);

  const summary: ManyTrialsSummary = {
    strategy,
    trialCount: pairs.length,
    deadlockCount,
    bothCommittedCount,
    anomalyCount,
    totalBalanceBeforeCents,
    totalBalanceAfterCents,
    balanceConserved: totalBalanceBeforeCents === totalBalanceAfterCents,
  };

  return { summary, results };
}

function parseArgs(): { trials: number } {
  const args = process.argv.slice(2);
  const trialsArg = args.find((a) => a.startsWith("--trials="));
  const trials = trialsArg ? Number(trialsArg.split("=")[1]) : DEFAULT_TRIALS;
  if (!Number.isFinite(trials) || trials <= 0) {
    throw new Error(`--trials must be a positive integer, got "${trialsArg}"`);
  }
  return { trials };
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  const { trials } = parseArgs();

  await waitForDatabase(pool);
  const allPairs = await getTrialPairs(pool);
  if (allPairs.length < trials * 2) {
    throw new Error(
      `not enough seeded trial pairs (${allPairs.length}) for --trials=${trials} on both strategies - reseed with a larger --pairs=`,
    );
  }

  const naivePairs = allPairs.slice(0, trials);
  const orderedPairs = allPairs.slice(trials, trials * 2);

  log.info({ trials }, "running naive-lock-order trials (expect a real deadlock on EVERY pair)...");
  const naive = await runManyTrials(connectionString, naivePairs, "naive-lock-order");
  log.warn({ ...naive.summary }, "naive-lock-order summary");

  log.info({ trials }, "running consistent-lock-order trials (expect ZERO deadlocks)...");
  const ordered = await runManyTrials(connectionString, orderedPairs, "consistent-lock-order");
  log.warn({ ...ordered.summary }, "consistent-lock-order summary");

  log.warn(
    {
      naiveDeadlockRate: `${naive.summary.deadlockCount}/${naive.summary.trialCount}`,
      orderedDeadlockRate: `${ordered.summary.deadlockCount}/${ordered.summary.trialCount}`,
    },
    "COMPARISON: identical business scenario, only the lock acquisition order differs",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "many-trials scenario failed");
    process.exit(1);
  });
}
