import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { accounts } from "../../src/db/schema.js";
import { SCENARIO_ACCOUNTS } from "../../src/seed/scenario-accounts.js";
import { runRetryOnDeadlock } from "../../src/scenarios/retry-on-deadlock.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.insert(accounts).values([...SCENARIO_ACCOUNTS]).onConflictDoNothing();
});

afterAll(async () => {
  await pool.end();
});

describe("retry-on-deadlock recovers from the same real deadlock, after the fact", () => {
  it("still forms a real deadlock on attempt 1, then both legs eventually commit", async () => {
    const result = await runRetryOnDeadlock(process.env.DATABASE_URL!);

    expect(result.bothEventuallyCommitted).toBe(true);
    expect(result.outcomeA.status).toBe("committed");
    expect(result.outcomeB.status).toBe("committed");

    // Exactly one of the two legs must have been a deadlock victim on its
    // first attempt (attempts > 1) - the OTHER leg won outright (attempts === 1).
    const attemptCounts = [result.outcomeA.attempts, result.outcomeB.attempts].sort((a, b) => a - b);
    expect(attemptCounts).toEqual([1, 2]);
    expect(result.totalDeadlocksObserved).toBe(1);
  });

  it("reflects BOTH transfers in the final balances despite the retry", async () => {
    const result = await runRetryOnDeadlock(process.env.DATABASE_URL!);

    expect(result.finalBalanceAccountA).toBe(result.expectedBalanceAccountA);
    expect(result.finalBalanceAccountB).toBe(result.expectedBalanceAccountB);
  });
});
