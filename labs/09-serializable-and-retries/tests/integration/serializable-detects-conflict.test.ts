import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { onCallStaff } from "../../src/db/schema.js";
import { SCENARIO_STAFF } from "../../src/seed/scenario-staff.js";
import { runSerializableDetectsConflict } from "../../src/scenarios/serializable-detects-conflict.js";
import { SERIALIZATION_FAILURE_SQLSTATE } from "../../src/scenarios/support.js";

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

describe("Serializable detects the write-skew dependency and aborts one transaction", () => {
  it("the same interleaving under SERIALIZABLE lets Alice commit but rejects Bob with SQLSTATE 40001", async () => {
    const result = await runSerializableDetectsConflict(process.env.DATABASE_URL!);

    expect(result.actualIsolationLevel).toBe("serializable");
    expect(result.aliceCommitted).toBe(true);
    expect(result.bobCommitted).toBe(false);
    expect(result.bobFailure).not.toBeNull();
    expect(result.bobFailure?.sqlstate).toBe(SERIALIZATION_FAILURE_SQLSTATE);
  });

  it("leaves the invariant intact: exactly one staff member is still on call after resolution", async () => {
    const result = await runSerializableDetectsConflict(process.env.DATABASE_URL!);

    expect(result.onCallCountAfter).toBe(1);
    expect(result.invariantHeld).toBe(true);
  });
});
