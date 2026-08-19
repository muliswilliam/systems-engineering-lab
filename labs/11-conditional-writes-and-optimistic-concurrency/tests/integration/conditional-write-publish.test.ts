import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { documents } from "../../src/db/schema.js";
import { SCENARIO_DOCUMENTS } from "../../src/seed/scenario-documents.js";
import { runConditionalWritePublish } from "../../src/scenarios/conditional-write-publish.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.insert(documents).values([...SCENARIO_DOCUMENTS]).onConflictDoNothing();
});

afterAll(async () => {
  await pool.end();
});

describe("UPDATE ... WHERE status = 'draft' is a conditional write with no version column", () => {
  it("exactly one of 10 concurrent publish attempts succeeds - the invariant, not timing", async () => {
    const result = await runConditionalWritePublish(process.env.DATABASE_URL!, 10);

    expect(result.attemptCount).toBe(10);
    expect(result.successCount).toBe(1);
    expect(result.conflictCount).toBe(9);
    expect(result.finalStatus).toBe("published");

    // Assert on the actual rowCount values, not just aggregate counts.
    const successRowCounts = result.rowCounts.filter((c) => c === 1);
    const conflictRowCounts = result.rowCounts.filter((c) => c === 0);
    expect(successRowCounts).toHaveLength(1);
    expect(conflictRowCounts).toHaveLength(9);
  });

  it("still produces exactly one success at higher concurrency (25 attempts)", async () => {
    const result = await runConditionalWritePublish(process.env.DATABASE_URL!, 25);

    expect(result.successCount).toBe(1);
    expect(result.conflictCount).toBe(24);
  });
});
