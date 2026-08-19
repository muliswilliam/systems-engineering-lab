import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { accounts } from "../../src/db/schema.js";
import { SCENARIO_ACCOUNTS } from "../../src/seed/scenario-data.js";
import { runConcurrentWriteConflict } from "../../src/scenarios/concurrent-write-conflict.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.insert(accounts).values([...SCENARIO_ACCOUNTS]).onConflictDoNothing();
});

afterAll(async () => {
  await pool.end();
});

describe("two REPEATABLE READ transactions updating the same row: exactly one succeeds", () => {
  it("commits transaction A and rejects transaction B with SQLSTATE 40001, rather than silently losing A's update", async () => {
    const result = await runConcurrentWriteConflict(process.env.DATABASE_URL!);

    expect(result.aCommitted).toBe(true);
    expect(result.bFailed).toBe(true);
    expect(result.bErrorCode).toBe("40001");
    expect(result.bSawSerializationFailure).toBe(true);
    expect(result.bErrorMessage).toMatch(/could not serialize access due to concurrent update/i);

    // Final state proves this wasn't a lost update: the balance reflects
    // ONLY A's committed write, never B's rejected one.
    expect(result.finalBalanceCents).toBe(result.aNewBalance);
    expect(result.finalBalanceCents).not.toBe(result.bAttemptedNewBalance);
    expect(result.finalBalanceMatchesA).toBe(true);
  });
});
