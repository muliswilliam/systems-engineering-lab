import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { pool, waitForDatabase, db } from "../../src/db/client.js";
import { ensureScenarioCompanies } from "../../src/seed/ensure-scenario-companies.js";
import { runConnectionLossReleasesLock } from "../../src/scenarios/connection-loss-releases-lock.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await ensureScenarioCompanies();
});

afterAll(async () => {
  await pool.end();
});

describe("closing a connection releases the session-level advisory locks it held", () => {
  it("makes the key available to a new session once the holding connection ends, with no explicit unlock call", async () => {
    const result = await runConnectionLossReleasesLock(process.env.DATABASE_URL!);

    expect(result.workerBAcquiredWhileAHeldOpen).toBe(false);
    expect(result.workerBAcquiredAfterConnectionClosed).toBe(true);
  });
});
