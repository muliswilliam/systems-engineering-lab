import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { accounts } from "../../src/db/schema.js";
import { SCENARIO_ACCOUNTS } from "../../src/seed/scenario-accounts.js";
import { runNowait, runLockTimeout } from "../../src/scenarios/nowait-and-lock-timeout.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.insert(accounts).values([...SCENARIO_ACCOUNTS]).onConflictDoNothing();
});

afterAll(async () => {
  await pool.end();
});

describe("SELECT ... FOR UPDATE NOWAIT against an already-locked row", () => {
  it("throws immediately with SQLSTATE 55P03 instead of blocking", async () => {
    const result = await runNowait(process.env.DATABASE_URL!);

    expect(result.errorCode).toBe("55P03");
    expect(result.errorMessage).toMatch(/could not obtain lock/i);

    // Bounded max wait, not a timing-precision assertion: NOWAIT must not
    // have waited anywhere near as long as this lab's lock_timeout demo
    // deliberately waits (500ms).
    expect(result.elapsedMs).toBeLessThan(300);
    expect(result.raisedImmediately).toBe(true);
  });
});

describe("SET LOCAL lock_timeout bounds how long a blocked FOR UPDATE will wait", () => {
  it("aborts the blocked statement after the configured timeout with SQLSTATE 55P03", async () => {
    const result = await runLockTimeout(process.env.DATABASE_URL!, 500);

    expect(result.errorCode).toBe("55P03");
    expect(result.errorMessage).toMatch(/lock timeout/i);

    // Must have genuinely waited close to (at least) the configured budget -
    // this distinguishes lock_timeout's abort from NOWAIT's instant failure.
    expect(result.elapsedMs).toBeGreaterThanOrEqual(500);
    expect(result.abortedAfterTimeout).toBe(true);
  });
});
