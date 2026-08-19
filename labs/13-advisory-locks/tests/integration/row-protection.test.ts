import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { pool, waitForDatabase, db } from "../../src/db/client.js";
import { ensureScenarioCompanies } from "../../src/seed/ensure-scenario-companies.js";
import { runAdvisoryLockDoesNotProtectRows } from "../../src/scenarios/advisory-lock-does-not-protect-rows.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await ensureScenarioCompanies();
});

afterAll(async () => {
  await pool.end();
});

describe("an advisory lock does not block a connection that never calls it", () => {
  it("lets a direct UPDATE from a non-cooperating connection succeed instantly while the lock is held elsewhere", async () => {
    const result = await runAdvisoryLockDoesNotProtectRows(process.env.DATABASE_URL!);

    expect(result.directUpdateRowCount).toBe(1);
    expect(result.directUpdateSucceededWhileLockHeld).toBe(true);
    expect(result.finalStatus).toBe("corrupted-by-bypass");
    // The correctness fact this lab exists to demonstrate: the lock's mere
    // existence, held by a different, cooperating connection, did nothing to
    // slow down or reject a write from a connection that never checked it.
    expect(result.directUpdateDurationMs).toBeLessThan(1000);
  });
});
