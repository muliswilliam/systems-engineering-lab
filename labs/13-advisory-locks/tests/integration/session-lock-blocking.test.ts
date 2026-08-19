import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { pool, waitForDatabase, db } from "../../src/db/client.js";
import { ensureScenarioCompanies } from "../../src/seed/ensure-scenario-companies.js";
import { runSessionLockBlocking } from "../../src/scenarios/session-lock-blocking.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await ensureScenarioCompanies();
});

afterAll(async () => {
  await pool.end();
});

describe("pg_try_advisory_lock reflects real per-key contention, not a global lock", () => {
  it("returns false for the same key while held, true immediately for a different key, and true again after release", async () => {
    const result = await runSessionLockBlocking(process.env.DATABASE_URL!);

    expect(result.companyAId).not.toBe(result.companyBId);
    expect(result.workerBAcquiredWhileALocked).toBe(false);
    expect(result.workerCAcquiredDifferentKeyImmediately).toBe(true);
    expect(result.workerBRetryAfterReleaseAcquired).toBe(true);
  });
});
