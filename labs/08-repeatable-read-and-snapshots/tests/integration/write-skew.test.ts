import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { onCallStaff } from "../../src/db/schema.js";
import { SCENARIO_STAFF } from "../../src/seed/scenario-data.js";
import { runWriteSkew } from "../../src/scenarios/write-skew.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.insert(onCallStaff).values([...SCENARIO_STAFF]).onConflictDoNothing();
});

afterAll(async () => {
  await pool.end();
});

describe("write skew: REPEATABLE READ does not catch a cross-row invariant violation", () => {
  // This is an intentionally unusual assertion: we are asserting that the
  // BAD outcome actually happened. That is the whole teaching point of this
  // test. REPEATABLE READ is not supposed to prevent write skew - only
  // Serializable (Lab 09) detects this dangerous structure. If this test
  // ever started asserting `invariantViolated === false`, that would mean
  // either Postgres's documented Repeatable Read behavior changed, or the
  // scenario stopped reproducing the anomaly it exists to demonstrate -
  // both would be worth investigating, not "test finally passing".
  it("lets both transactions commit even though the result violates 'at least one is on call'", async () => {
    const result = await runWriteSkew(process.env.DATABASE_URL!);

    // Neither transaction's individual read was wrong - both genuinely saw
    // the other doctor as on call, from their own valid snapshot.
    expect(result.aSawBOnCallBeforeWriting).toBe(true);
    expect(result.bSawAOnCallBeforeWriting).toBe(true);

    // Both independently decided to go off call, and both writes committed
    // successfully - no serialization failure, because they touched
    // different rows.
    expect(result.aWentOffCall).toBe(true);
    expect(result.bWentOffCall).toBe(true);
    expect(result.aCommitted).toBe(true);
    expect(result.bCommitted).toBe(true);

    // The actual anomaly: the cross-row invariant "at least one on-call
    // staff member" is now violated.
    expect(result.finalOnCallCount).toBe(0);
    expect(result.invariantViolated).toBe(true);
  });
});
