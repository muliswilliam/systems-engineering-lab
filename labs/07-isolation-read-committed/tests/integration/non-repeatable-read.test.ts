import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { accounts } from "../../src/db/schema.js";
import { SCENARIO_ACCOUNTS } from "../../src/seed/scenario-accounts.js";
import { runNonRepeatableRead } from "../../src/scenarios/non-repeatable-read.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.insert(accounts).values([...SCENARIO_ACCOUNTS]).onConflictDoNothing();
});

afterAll(async () => {
  await pool.end();
});

describe("Read Committed grants a fresh snapshot per statement, not per transaction", () => {
  it("returns different values for two SELECTs of the same row, in the same transaction, with a committed UPDATE in between", async () => {
    const result = await runNonRepeatableRead(process.env.DATABASE_URL!);

    expect(result.firstRead).toBe(result.baselineBalanceCents);
    expect(result.secondRead).toBe(result.committedBalanceCents);
    expect(result.readsDiffer).toBe(true);
    expect(result.secondReadMatchesCommittedValue).toBe(true);
  });

  it("is the default isolation level - no explicit SET TRANSACTION ISOLATION LEVEL is required", async () => {
    const result = await runNonRepeatableRead(process.env.DATABASE_URL!);
    expect(result.actualIsolationLevel).toBe("read committed");
  });
});
