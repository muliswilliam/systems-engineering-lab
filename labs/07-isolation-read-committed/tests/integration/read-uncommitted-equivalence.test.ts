import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { accounts } from "../../src/db/schema.js";
import { SCENARIO_ACCOUNTS } from "../../src/seed/scenario-accounts.js";
import { runEquivalenceDemo } from "../../src/scenarios/read-uncommitted-vs-read-committed.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.insert(accounts).values([...SCENARIO_ACCOUNTS]).onConflictDoNothing();
});

afterAll(async () => {
  await pool.end();
});

describe("Postgres's READ UNCOMMITTED behaves identically to READ COMMITTED", () => {
  it("echoes back whichever isolation level label was requested, even though behavior does not change", async () => {
    const { readCommitted, readUncommitted } = await runEquivalenceDemo(process.env.DATABASE_URL!);

    expect(readCommitted.requestedIsolationLevel).toBe("READ COMMITTED");
    expect(readUncommitted.requestedIsolationLevel).toBe("READ UNCOMMITTED");

    // `SHOW transaction_isolation` reports back the requested label - this
    // is NOT proof of two different implementations, it's just what the
    // setting variable holds. The behavioral proof is the next test.
    expect(readCommitted.actualIsolationLevel).toBe("read committed");
    expect(readUncommitted.actualIsolationLevel).toBe("read uncommitted");
  });

  it("produces the exact same non-repeatable-read outcome under both requested levels", async () => {
    const { readCommitted, readUncommitted, behaviorIsIdentical } = await runEquivalenceDemo(
      process.env.DATABASE_URL!,
    );

    expect(readCommitted.readsDiffer).toBe(true);
    expect(readUncommitted.readsDiffer).toBe(true);
    expect(readCommitted.firstRead).toBe(readUncommitted.firstRead);
    expect(readCommitted.secondRead).toBe(readUncommitted.secondRead);
    expect(behaviorIsIdentical).toBe(true);
  });
});
