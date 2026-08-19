import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { primaryDb, primaryPool, waitForDatabase as waitForPrimary } from "../../src/db/primary-client.js";
import { replicaPool, waitForDatabase as waitForReplica } from "../../src/db/replica-client.js";
import { userProfiles } from "../../src/db/schema.js";
import { setReplicaApplyDelay } from "../../src/lib/replication-control.js";

const ARTIFICIAL_DELAY_MS = 400;

beforeAll(async () => {
  await waitForPrimary(primaryPool);
  await migrate(primaryDb, { migrationsFolder: "drizzle" });
  await waitForReplica(replicaPool);
});

afterAll(async () => {
  await setReplicaApplyDelay(replicaPool, 0);
  await primaryPool.end();
  await replicaPool.end();
});

describe("Strategy A - read-your-writes routed to the primary", () => {
  it("is correct on every trial regardless of real induced lag, because the read never touches the replica", async () => {
    const [profile] = await primaryDb
      .insert(userProfiles)
      .values({ displayName: "original-name", bio: "strategy-a test row" })
      .returning({ id: userProfiles.id });
    expect(profile).toBeDefined();

    await setReplicaApplyDelay(replicaPool, ARTIFICIAL_DELAY_MS);

    let correctCount = 0;
    const trials = 10;
    for (let i = 0; i < trials; i += 1) {
      const newName = `sticky-primary-${i}`;
      await primaryDb.update(userProfiles).set({ displayName: newName }).where(eq(userProfiles.id, profile!.id));

      // STRATEGY A: read from the primary, not the replica.
      const primaryResult = await primaryPool.query<{ display_name: string }>(
        "SELECT display_name FROM user_profiles WHERE id = $1",
        [profile!.id],
      );
      if (primaryResult.rows[0]?.display_name === newName) {
        correctCount += 1;
      }
    }

    expect(correctCount).toBe(trials);
  });

  it("can still go stale once the sticky window is shorter than real lag", async () => {
    const [profile] = await primaryDb
      .insert(userProfiles)
      .values({ displayName: "original-name", bio: "strategy-a window-leak test row" })
      .returning({ id: userProfiles.id });
    expect(profile).toBeDefined();

    const stickyWindowMs = 100;
    await setReplicaApplyDelay(replicaPool, ARTIFICIAL_DELAY_MS);

    const newName = "window-leak-update";
    await primaryDb.update(userProfiles).set({ displayName: newName }).where(eq(userProfiles.id, profile!.id));

    // Simulate the sticky window elapsing (100ms) while real lag (400ms)
    // has not cleared yet.
    await new Promise((resolve) => setTimeout(resolve, stickyWindowMs));

    const replicaResult = await replicaPool.query<{ display_name: string }>(
      "SELECT display_name FROM user_profiles WHERE id = $1",
      [profile!.id],
    );

    // This is the documented limitation of Strategy A: a too-short sticky
    // window does not protect against real lag that outlasts it.
    expect(replicaResult.rows[0]?.display_name).not.toBe(newName);
  });
});
