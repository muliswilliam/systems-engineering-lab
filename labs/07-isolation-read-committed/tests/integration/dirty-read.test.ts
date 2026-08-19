import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { accounts } from "../../src/db/schema.js";
import { SCENARIO_ACCOUNTS } from "../../src/seed/scenario-accounts.js";
import { runDirtyReadAttempt } from "../../src/scenarios/dirty-read-attempt.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.insert(accounts).values([...SCENARIO_ACCOUNTS]).onConflictDoNothing();
});

afterAll(async () => {
  await pool.end();
});

describe("dirty reads never occur in Postgres, even under a requested READ UNCOMMITTED", () => {
  it("does not let transaction B observe transaction A's uncommitted write", async () => {
    const result = await runDirtyReadAttempt(process.env.DATABASE_URL!);

    // The correctness fact this lab exists to demonstrate: B's read, taken
    // while A's UPDATE was still uncommitted, must equal the ORIGINAL
    // (committed) value - not A's in-flight value. This is an assertion
    // about the value actually read, not about timing.
    expect(result.balanceSeenWhileAUncommitted).toBe(result.originalBalanceCents);
    expect(result.balanceSeenWhileAUncommitted).not.toBe(result.uncommittedBalanceCents);
    expect(result.sawDirtyRead).toBe(false);

    // Once A commits, B's next read (same open transaction) does see the
    // now-committed value - proving B's earlier read wasn't just stale or
    // broken, it specifically excluded the uncommitted write.
    expect(result.balanceSeenAfterACommit).toBe(result.uncommittedBalanceCents);
  });

  it("accepts READ UNCOMMITTED as a valid isolation level name", async () => {
    const result = await runDirtyReadAttempt(process.env.DATABASE_URL!);
    expect(result.requestedIsolationLevel).toBe("READ UNCOMMITTED");
    expect(typeof result.actualIsolationLevel).toBe("string");
    expect(result.actualIsolationLevel.length).toBeGreaterThan(0);
  });
});
