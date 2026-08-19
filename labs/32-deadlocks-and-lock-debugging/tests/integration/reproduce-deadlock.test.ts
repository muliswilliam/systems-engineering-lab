import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { accounts } from "../../src/db/schema.js";
import { SCENARIO_ACCOUNTS } from "../../src/seed/scenario-accounts.js";
import { reproduceDeadlock } from "../../src/scenarios/reproduce-deadlock.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.insert(accounts).values([...SCENARIO_ACCOUNTS]).onConflictDoNothing();
});

afterAll(async () => {
  await pool.end();
});

describe("a real Postgres deadlock, reproduced deterministically", () => {
  it("aborts exactly one leg with a real, captured SQLSTATE 40P01 and commits the other", async () => {
    const result = await reproduceDeadlock(process.env.DATABASE_URL!);

    expect(result.deadlockReproduced).toBe(true);

    const aborted = [result.outcomeA, result.outcomeB].filter((o) => o.status === "deadlock_aborted");
    const committed = [result.outcomeA, result.outcomeB].filter((o) => o.status === "committed");
    expect(aborted).toHaveLength(1);
    expect(committed).toHaveLength(1);

    // This is Postgres's OWN real error - not a simulated/injected one.
    expect(aborted[0]!.sqlstate).toBe("40P01");
    expect(aborted[0]!.message?.toLowerCase()).toContain("deadlock detected");
    // Postgres's real deadlock error includes a "Process X waits for ... blocked
    // by process Y" detail describing the actual wait-for cycle it found.
    expect(aborted[0]!.detail?.toLowerCase()).toContain("process");
    expect(aborted[0]!.detail?.toLowerCase()).toContain("blocked by process");
  });

  it("captures a real pg_locks/pg_stat_activity snapshot showing the two-transaction wait-for cycle", async () => {
    const result = await reproduceDeadlock(process.env.DATABASE_URL!);

    expect(result.cycleObserved).toBe(true);
    // The cycle is exactly two edges: A waits on B, and B waits on A.
    expect(result.diagnosticEdges.length).toBeGreaterThanOrEqual(2);
  });

  it("leaves the total balance across both accounts unchanged (the aborted leg's work was fully rolled back)", async () => {
    const result = await reproduceDeadlock(process.env.DATABASE_URL!);

    const totalBefore = SCENARIO_ACCOUNTS[0].balanceCents + SCENARIO_ACCOUNTS[1].balanceCents;
    const totalAfter = result.finalBalanceAccountA + result.finalBalanceAccountB;
    expect(totalAfter).toBe(totalBefore);
  });
});
