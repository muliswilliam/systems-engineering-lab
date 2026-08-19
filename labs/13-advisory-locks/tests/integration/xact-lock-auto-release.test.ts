import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { pool, waitForDatabase, db } from "../../src/db/client.js";
import { ensureScenarioCompanies } from "../../src/seed/ensure-scenario-companies.js";
import { runXactLockAutoRelease } from "../../src/scenarios/xact-lock-auto-release.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await ensureScenarioCompanies();
});

afterAll(async () => {
  await pool.end();
});

describe("pg_advisory_xact_lock releases automatically at end-of-transaction, with no unlock call", () => {
  it("blocks a concurrent try-lock while the holder's transaction is open, and frees the key immediately after COMMIT", async () => {
    const result = await runXactLockAutoRelease(process.env.DATABASE_URL!);

    expect(result.acquiredWhileOpenCommitCase).toBe(false);
    expect(result.acquiredImmediatelyAfterCommit).toBe(true);
  });

  it("also frees the key immediately after ROLLBACK", async () => {
    const result = await runXactLockAutoRelease(process.env.DATABASE_URL!);

    expect(result.acquiredWhileOpenRollbackCase).toBe(false);
    expect(result.acquiredImmediatelyAfterRollback).toBe(true);
  });
});
