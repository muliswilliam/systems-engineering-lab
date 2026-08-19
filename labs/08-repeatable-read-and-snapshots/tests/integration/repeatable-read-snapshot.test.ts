import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { accounts } from "../../src/db/schema.js";
import { SCENARIO_ACCOUNTS } from "../../src/seed/scenario-data.js";
import { runRepeatableReadSnapshot } from "../../src/scenarios/repeatable-read-snapshot.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.insert(accounts).values([...SCENARIO_ACCOUNTS]).onConflictDoNothing();
});

afterAll(async () => {
  await pool.end();
});

describe("REPEATABLE READ grants one snapshot for the whole transaction, not per statement", () => {
  it("returns the SAME (stale) value for two SELECTs of the same row, in the same transaction, with a committed UPDATE from another transaction in between", async () => {
    const result = await runRepeatableReadSnapshot(process.env.DATABASE_URL!, {
      isolationLevel: "REPEATABLE READ",
    });

    expect(result.actualIsolationLevel).toBe("repeatable read");
    expect(result.firstRead).toBe(result.baselineBalanceCents);
    // The key fact this lab exists to demonstrate: unlike Read Committed,
    // the second read does NOT pick up B's committed change.
    expect(result.secondRead).toBe(result.firstRead);
    expect(result.secondRead).not.toBe(result.committedBalanceCents);
    expect(result.secondReadMatchesFirstRead).toBe(true);
    expect(result.secondReadMatchesCommittedValue).toBe(false);
  });

  // Self-contained contrast with Lab 07's Read Committed behavior - this
  // lab does not import Lab 07's code (labs are independent), so the exact
  // same setup is replayed here under READ COMMITTED to prove the two
  // isolation levels genuinely diverge on the same scenario.
  it("contrasts with READ COMMITTED, where the second read DOES pick up the committed change", async () => {
    const result = await runRepeatableReadSnapshot(process.env.DATABASE_URL!, {
      isolationLevel: "READ COMMITTED",
    });

    expect(result.actualIsolationLevel).toBe("read committed");
    expect(result.secondRead).toBe(result.committedBalanceCents);
    expect(result.secondReadMatchesFirstRead).toBe(false);
  });
});
