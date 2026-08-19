import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { onCallStaff } from "../../src/db/schema.js";
import { SCENARIO_STAFF } from "../../src/seed/scenario-staff.js";
import { runWriteSkewUnderRepeatableRead } from "../../src/scenarios/write-skew-under-repeatable-read.js";

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

describe("write skew under Repeatable Read violates the 'at least one on call' invariant", () => {
  it("both Alice and Bob independently decide it is safe to go off call, both commit, and nobody is left on call", async () => {
    const result = await runWriteSkewUnderRepeatableRead(process.env.DATABASE_URL!);

    expect(result.actualIsolationLevel).toBe("repeatable read");

    // Each transaction's own snapshot showed the OTHER staff member still on
    // call, so each independently concluded it was safe to go off call.
    expect(result.othersOnCallSeenByAlice).toBe(1);
    expect(result.othersOnCallSeenByBob).toBe(1);
    expect(result.aliceDecision).toBe("go-off-call");
    expect(result.bobDecision).toBe("go-off-call");

    // Both commits succeed under Repeatable Read - no serialization error is
    // ever raised for this anomaly at this isolation level.
    expect(result.onCallCountAfter).toBe(0);
    expect(result.invariantHeld).toBe(false);
  });
});
