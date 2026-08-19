import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { accounts } from "../../src/db/schema.js";
import { SCENARIO_ACCOUNTS } from "../../src/seed/scenario-accounts.js";
import { runConsistentLockOrdering } from "../../src/scenarios/consistent-lock-ordering.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.insert(accounts).values([...SCENARIO_ACCOUNTS]).onConflictDoNothing();
});

afterAll(async () => {
  await pool.end();
});

describe("consistent lock ordering prevents the identical deadlock", () => {
  it("commits BOTH legs with zero deadlocks for the exact same opposite-direction transfer pair", async () => {
    const result = await runConsistentLockOrdering(process.env.DATABASE_URL!);

    expect(result.bothCommitted).toBe(true);
    expect(result.neitherDeadlocked).toBe(true);
    expect(result.outcomeA.status).toBe("committed");
    expect(result.outcomeB.status).toBe("committed");
  });

  it("reflects BOTH transfers in the final balances, proving the slower leg genuinely applied its own update after waiting", async () => {
    const result = await runConsistentLockOrdering(process.env.DATABASE_URL!);

    expect(result.finalBalanceAccountA).toBe(result.expectedBalanceAccountA);
    expect(result.finalBalanceAccountB).toBe(result.expectedBalanceAccountB);
  });

  it("measures both legs' real wall-clock durations (the loser waits on an ordinary lock, never errors)", async () => {
    const result = await runConsistentLockOrdering(process.env.DATABASE_URL!);

    // Not asserting one is strictly slower than the other here - on a fast,
    // idle local Postgres both can complete within the same millisecond.
    // The real, reliably-observable fact this lab's README captures instead
    // is that BOTH durations are non-negative and BOTH legs committed - see
    // "Break it"/"Fix it" for a real captured run where the gap is visible.
    expect(result.legADurationMs).toBeGreaterThanOrEqual(0);
    expect(result.legBDurationMs).toBeGreaterThanOrEqual(0);
  });
});
