import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { documents } from "../../src/db/schema.js";
import { SCENARIO_DOCUMENTS } from "../../src/seed/scenario-documents.js";
import { runOptimisticConcurrency } from "../../src/scenarios/optimistic-concurrency.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.insert(documents).values([...SCENARIO_DOCUMENTS]).onConflictDoNothing();
});

afterAll(async () => {
  await pool.end();
});

describe("UPDATE ... WHERE id = ? AND version = ? detects a concurrent edit conflict", () => {
  it("the first writer's conditional UPDATE matches exactly one row (rowCount=1)", async () => {
    const result = await runOptimisticConcurrency(process.env.DATABASE_URL!);

    expect(result.userAUpdateRowCount).toBe(1);
    expect(result.userAUpdateNewVersion).toBe(2);
  });

  it("the second writer's stale-version UPDATE matches zero rows (rowCount=0) - a conflict, not an exception", async () => {
    const result = await runOptimisticConcurrency(process.env.DATABASE_URL!);

    expect(result.userBFirstAttemptRowCount).toBe(0);
    expect(result.conflictDetected).toBe(true);
  });

  it("re-reading the fresh version and retrying succeeds, and the final document reflects both edits", async () => {
    const result = await runOptimisticConcurrency(process.env.DATABASE_URL!);

    // Retry succeeded: matched exactly one row, on the SECOND attempt.
    expect(result.userBRetryUpdateRowCount).toBe(1);
    expect(result.retrySucceeded).toBe(true);

    // Exactly three successful conditional writes happened against this row
    // in total (A's write, then B's retry) - version 1 -> 2 -> 3.
    expect(result.finalVersion).toBe(3);

    // The precise, deterministic definition of "both edits reflected" for
    // this lab's retry strategy: B re-applied its edit on top of the CURRENT
    // (post-A) body, so the final body is the original text, followed by
    // A's marker, followed by B's marker - in that exact order.
    expect(result.bothEditsPresent).toBe(true);
    expect(result.finalBody).toBe(
      `${result.originalBody}\n\n-- User A's addition: fixed the typo in Section 1.\n\n-- User B's addition: added a Section 3 on rollout risks.`,
    );
  });
});
