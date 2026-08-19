import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { documents } from "../../src/db/schema.js";
import { SCENARIO_DOCUMENTS } from "../../src/seed/scenario-documents.js";
import { runLostUpdateNaive } from "../../src/scenarios/lost-update-naive.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.insert(documents).values([...SCENARIO_DOCUMENTS]).onConflictDoNothing();
});

afterAll(async () => {
  await pool.end();
});

describe("a plain UPDATE with no version check produces a real lost update", () => {
  it("reports rowCount=1 (success) for BOTH users' UPDATEs, yet only the later write survives", async () => {
    const result = await runLostUpdateNaive(process.env.DATABASE_URL!);

    // Both writers "succeeded" from the database's point of view - neither
    // received an error, a zero rowCount, or any other signal that something
    // was wrong.
    expect(result.userAUpdateRowCount).toBe(1);
    expect(result.userBUpdateRowCount).toBe(1);

    // The real fact this lab exists to demonstrate: the final body equals
    // ONLY user B's edit. User A's edit is not merged, not queued, not
    // recoverable from this table - it is gone.
    expect(result.finalBody).toBe(result.userBEditedBody);
    expect(result.finalBody).not.toBe(result.userAEditedBody);
    expect(result.userAEditSurvived).toBe(false);
    expect(result.userBEditSurvived).toBe(true);
    expect(result.lostUpdateOccurred).toBe(true);
  });

  it("both users read the identical, still-original body before either saved", async () => {
    const result = await runLostUpdateNaive(process.env.DATABASE_URL!);

    expect(result.userAReadBody).toBe(result.originalBody);
    expect(result.userBReadBody).toBe(result.originalBody);
  });
});
