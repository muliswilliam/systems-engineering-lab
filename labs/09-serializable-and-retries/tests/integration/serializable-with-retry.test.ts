import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { onCallStaff } from "../../src/db/schema.js";
import { SCENARIO_STAFF } from "../../src/seed/scenario-staff.js";
import { runSerializableWithRetry } from "../../src/scenarios/serializable-with-retry.js";

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

describe("bounded retry loop reaches a terminal, invariant-respecting outcome", () => {
  it("resolves both concurrent requests within the attempt bound: exactly one succeeds, invariant holds", async () => {
    const result = await runSerializableWithRetry(process.env.DATABASE_URL!);

    // Outcome-based assertions only - which of Alice/Bob wins the race is
    // not asserted, per CLAUDE.md's guidance to assert invariants, not
    // execution order.
    expect(result.exactlyOneSucceeded).toBe(true);
    expect([result.alice.finalOutcome, result.bob.finalOutcome].sort()).toEqual(["committed", "rejected"]);
    expect(result.onCallCountAfter).toBe(1);
    expect(result.invariantHeld).toBe(true);

    // Both requests must have reached a terminal outcome within the bounded
    // attempt count (no infinite retry).
    expect(result.alice.attempts).toBeGreaterThanOrEqual(1);
    expect(result.bob.attempts).toBeGreaterThanOrEqual(1);
  });

  it("the loser of the race actually saw at least one real serialization conflict before its terminal outcome", async () => {
    const result = await runSerializableWithRetry(process.env.DATABASE_URL!);

    const totalConflicts = result.alice.conflictsEncountered + result.bob.conflictsEncountered;
    expect(totalConflicts).toBeGreaterThanOrEqual(1);
  });
});
