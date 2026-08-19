import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { onCallStaff } from "../../src/db/schema.js";
import { SCENARIO_STAFF } from "../../src/seed/scenario-staff.js";
import { runContentionUnderRepeatableRead, runContentionUnderSerializable } from "../../src/scenarios/contention-and-throughput.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await db
    .insert(onCallStaff)
    .values(SCENARIO_STAFF.map((s) => ({ ...s, isOnCall: true })))
    .onConflictDoNothing();
});

afterAll(async () => {
  await pool.end();
});

describe("Serializable under N-way contention: correctness at the cost of aborts and retries", () => {
  it("N staff concurrently going off call under Serializable+retry leaves exactly one on call", async () => {
    const result = await runContentionUnderSerializable(process.env.DATABASE_URL!);

    expect(result.invariantHeld).toBe(true);
    expect(result.onCallCountAfter).toBe(1);
    expect(result.committedCount).toBe(result.staffCount - 1);
    expect(result.rejectedCount).toBe(1);
    // Contention cost: with 5 fully-overlapping attempts, at least one
    // serialization conflict must have occurred (otherwise nothing would
    // have needed to retry to reach the correct 4-committed/1-rejected split).
    expect(result.totalConflicts).toBeGreaterThanOrEqual(1);
    expect(result.totalAttempts).toBeGreaterThan(result.staffCount);
  });
});

describe("the same N-way workload under Repeatable Read with no retry: zero aborts, wrong result", () => {
  it("every worker's own snapshot looks safe, so all N go off call and the invariant is violated", async () => {
    const result = await runContentionUnderRepeatableRead(process.env.DATABASE_URL!);

    expect(result.totalConflicts).toBe(0);
    expect(result.wentOffCallCount).toBe(result.staffCount);
    expect(result.onCallCountAfter).toBe(0);
    expect(result.invariantHeld).toBe(false);
  });
});
