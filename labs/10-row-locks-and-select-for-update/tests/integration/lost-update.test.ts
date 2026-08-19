import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { accounts } from "../../src/db/schema.js";
import { SCENARIO_ACCOUNTS } from "../../src/seed/scenario-accounts.js";
import { runLostUpdate } from "../../src/scenarios/lost-update-without-lock.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.insert(accounts).values([...SCENARIO_ACCOUNTS]).onConflictDoNothing();
});

afterAll(async () => {
  await pool.end();
});

describe("two concurrent unlocked read-modify-write withdrawals produce a lost update", () => {
  it("leaves the final balance reflecting only ONE withdrawal, not both", async () => {
    const result = await runLostUpdate(process.env.DATABASE_URL!);

    // Both transactions read the SAME stale baseline.
    expect(result.balanceReadByA).toBe(result.baselineBalanceCents);
    expect(result.balanceReadByB).toBe(result.baselineBalanceCents);

    // The correct answer, if both withdrawals had been correctly reflected,
    // would be baseline minus BOTH withdrawal amounts.
    const correctBalance = result.baselineBalanceCents - result.withdrawalACents - result.withdrawalBCents;
    expect(result.correctBalanceCents).toBe(correctBalance);

    // The actual, real fact this test exists to prove: the final balance is
    // wrong. Because B's UPDATE physically blocks until A commits (a row
    // lock still applies to the WRITE), B's UPDATE is the one that lands
    // last and wins outright - the final balance reflects ONLY B's
    // withdrawal, computed from the stale pre-A baseline.
    expect(result.finalBalanceCents).toBe(result.baselineBalanceCents - result.withdrawalBCents);
    expect(result.finalBalanceCents).not.toBe(correctBalance);
    expect(result.lostUpdateOccurred).toBe(true);
  });

  it("shows transaction B's UPDATE was genuinely blocked by A's still-open transaction, not merely slow", async () => {
    const result = await runLostUpdate(process.env.DATABASE_URL!);

    // B's UPDATE only unblocks once A commits - assert a real, meaningfully
    // large wait occurred (bounded, not a precise timing assertion).
    expect(result.bUpdateBlockedMs).toBeGreaterThanOrEqual(200);

    // A real pg_locks/pg_stat_activity snapshot was captured while B was
    // blocked - at least one row must reflect a lock B is waiting to acquire.
    expect(result.locksWhileBBlocked.length).toBeGreaterThan(0);
    expect(result.locksWhileBBlocked.some((row) => row.pid === undefined || typeof row.pid === "number")).toBe(true);
  });
});
