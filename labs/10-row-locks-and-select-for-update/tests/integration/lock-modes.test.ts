import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { accounts } from "../../src/db/schema.js";
import { SCENARIO_ACCOUNTS } from "../../src/seed/scenario-accounts.js";
import { runLockModes } from "../../src/scenarios/lock-modes.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.insert(accounts).values([...SCENARIO_ACCOUNTS]).onConflictDoNothing();
});

afterAll(async () => {
  await pool.end();
});

describe("FOR SHARE allows concurrent holders but blocks a writer", () => {
  it("lets two transactions hold FOR SHARE on the same row at once, without blocking", async () => {
    const result = await runLockModes(process.env.DATABASE_URL!);
    const { forShareConcurrent } = result;

    expect(forShareConcurrent.bothAcquiredWithoutBlocking).toBe(true);
  });

  it("blocks a writer's UPDATE until BOTH FOR SHARE holders have released", async () => {
    const result = await runLockModes(process.env.DATABASE_URL!);
    const { forShareConcurrent } = result;

    expect(forShareConcurrent.writerWaitedForBothReaders).toBe(true);
    expect(forShareConcurrent.writerBlockedMs).toBeGreaterThanOrEqual(200);
  });
});

describe("FOR UPDATE blocks a subsequent FOR SHARE (exclusive vs shared)", () => {
  it("makes a FOR SHARE reader wait until the FOR UPDATE holder commits", async () => {
    const result = await runLockModes(process.env.DATABASE_URL!);
    const { forUpdateBlocksForShare } = result;

    expect(forUpdateBlocksForShare.forShareBlockedOnForUpdate).toBe(true);
    expect(forUpdateBlocksForShare.forShareBlockedMs).toBeGreaterThanOrEqual(200);
  });
});

describe("an ordinary UPDATE's tuple-lock strength depends on which column it touches", () => {
  it("does not block a concurrent FOR KEY SHARE when updating a non-key column", async () => {
    const result = await runLockModes(process.env.DATABASE_URL!);
    const { keyShareVsNoKeyUpdate } = result;

    expect(keyShareVsNoKeyUpdate.keyShareAgainstNonKeyUpdateBlocked).toBe(false);
  });

  it("DOES block a concurrent FOR KEY SHARE when updating a column covered by a unique index", async () => {
    const result = await runLockModes(process.env.DATABASE_URL!);
    const { keyShareVsNoKeyUpdate } = result;

    expect(keyShareVsNoKeyUpdate.keyShareAgainstKeyUpdateBlocked).toBe(true);
  });
});
