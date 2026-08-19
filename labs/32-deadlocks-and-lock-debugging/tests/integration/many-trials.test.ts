import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { accounts } from "../../src/db/schema.js";
import { SCENARIO_ACCOUNTS } from "../../src/seed/scenario-accounts.js";
import { getTrialPairs } from "../../src/lib/trial-pairs.js";
import { runManyTrials } from "../../src/scenarios/many-trials.js";
import { generateAccounts } from "@labs/data-generators";
import { TRIAL_PAIR_BASELINE_BALANCE_CENTS } from "../../src/seed/scenario-accounts.js";

const TRIALS_PER_STRATEGY = 40;

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.insert(accounts).values([...SCENARIO_ACCOUNTS]).onConflictDoNothing();

  // Ensure enough trial-pair accounts exist regardless of how `pnpm seed`
  // was last run (e.g. a smaller `--pairs=` value) - this test needs
  // TWO disjoint pools of TRIALS_PER_STRATEGY pairs each (naive + ordered).
  const existingPairs = await getTrialPairs(pool);
  const needed = TRIALS_PER_STRATEGY * 2;
  if (existingPairs.length < needed) {
    const toCreate = (needed - existingPairs.length) * 2;
    const generated = generateAccounts(toCreate, 9001);
    const ownerNames = generated.map((a) => a.ownerName);
    const balances = new Array<number>(toCreate).fill(TRIAL_PAIR_BASELINE_BALANCE_CENTS);
    await pool.query(
      `INSERT INTO accounts (owner_name, balance_cents) SELECT * FROM unnest($1::text[], $2::integer[])`,
      [ownerNames, balances],
    );
  }
});

afterAll(async () => {
  await pool.end();
});

describe("many concurrent trials: identical scenario, only lock order differs", () => {
  it(`naive lock order: a real deadlock occurs on every one of ${TRIALS_PER_STRATEGY} independent concurrent trials`, async () => {
    const allPairs = await getTrialPairs(pool);
    const pairs = allPairs.slice(0, TRIALS_PER_STRATEGY);

    const { summary } = await runManyTrials(process.env.DATABASE_URL!, pairs, "naive-lock-order");

    expect(summary.trialCount).toBe(TRIALS_PER_STRATEGY);
    expect(summary.deadlockCount).toBe(TRIALS_PER_STRATEGY);
    expect(summary.bothCommittedCount).toBe(0);
    expect(summary.anomalyCount).toBe(0);
    expect(summary.balanceConserved).toBe(true);
  });

  it(`consistent lock ordering: ZERO deadlocks across the same ${TRIALS_PER_STRATEGY}-trial workload`, async () => {
    const allPairs = await getTrialPairs(pool);
    const pairs = allPairs.slice(TRIALS_PER_STRATEGY, TRIALS_PER_STRATEGY * 2);

    const { summary } = await runManyTrials(process.env.DATABASE_URL!, pairs, "consistent-lock-order");

    expect(summary.trialCount).toBe(TRIALS_PER_STRATEGY);
    expect(summary.deadlockCount).toBe(0);
    expect(summary.bothCommittedCount).toBe(TRIALS_PER_STRATEGY);
    expect(summary.anomalyCount).toBe(0);
    expect(summary.balanceConserved).toBe(true);
  });
});
