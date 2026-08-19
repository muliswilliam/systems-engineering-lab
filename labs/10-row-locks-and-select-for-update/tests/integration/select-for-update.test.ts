import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { accounts } from "../../src/db/schema.js";
import { SCENARIO_ACCOUNTS } from "../../src/seed/scenario-accounts.js";
import { runSelectForUpdate } from "../../src/scenarios/select-for-update.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.insert(accounts).values([...SCENARIO_ACCOUNTS]).onConflictDoNothing();
});

afterAll(async () => {
  await pool.end();
});

describe("two concurrent SELECT ... FOR UPDATE withdrawals correctly serialize", () => {
  it("reflects BOTH withdrawals in the final balance when funds are sufficient", async () => {
    const result = await runSelectForUpdate(process.env.DATABASE_URL!);

    expect(result.outcomeA.applied).toBe(true);
    expect(result.outcomeB.applied).toBe(true);

    // The real correctness fact: B's FOR UPDATE read (after unblocking) must
    // equal A's POST-withdrawal balance, not the stale pre-A baseline.
    expect(result.outcomeB.balanceSeen).toBe(result.baselineBalanceCents - result.withdrawalACents);

    const correctBalance = result.baselineBalanceCents - result.withdrawalACents - result.withdrawalBCents;
    expect(result.correctBalanceCents).toBe(correctBalance);
    expect(result.finalBalanceCents).toBe(correctBalance);
    expect(result.bothWithdrawalsCorrectlyReflected).toBe(true);
  });

  it("blocks transaction B's SELECT ... FOR UPDATE for a real, measurable wall-clock duration", async () => {
    const result = await runSelectForUpdate(process.env.DATABASE_URL!);

    expect(result.bSelectBlockedMs).toBeGreaterThanOrEqual(200);
    expect(result.locksWhileBBlocked.length).toBeGreaterThan(0);
  });

  it("correctly rejects the second withdrawal when it would overdraw the up-to-date balance", async () => {
    // Withdraw almost the whole balance first, leaving too little for the
    // second withdrawal - this must be REJECTED, not silently applied
    // against a stale balance.
    const result = await runSelectForUpdate(process.env.DATABASE_URL!, {
      withdrawalACents: 900_000,
      withdrawalBCents: 200_000,
    });

    expect(result.outcomeA.applied).toBe(true);
    expect(result.outcomeB.applied).toBe(false);
    expect(result.outcomeB.reason).toBe("insufficient_funds");

    // Final balance reflects ONLY A's withdrawal - B's rejection left the
    // balance untouched, and it never went negative.
    expect(result.finalBalanceCents).toBe(result.baselineBalanceCents - 900_000);
    expect(result.finalBalanceCents).toBeGreaterThanOrEqual(0);
    expect(result.bothWithdrawalsCorrectlyReflected).toBe(true);
  });
});
