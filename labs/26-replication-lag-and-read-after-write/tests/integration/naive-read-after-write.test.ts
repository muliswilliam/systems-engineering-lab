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

describe("naive read-after-write is genuinely broken under real induced lag", () => {
  it("a replica read immediately after a primary write returns the OLD value, real and repeatable across 10 trials", async () => {
    const [profile] = await primaryDb
      .insert(userProfiles)
      .values({ displayName: "original-name", bio: "naive test row" })
      .returning({ id: userProfiles.id, publicId: userProfiles.publicId });
    expect(profile).toBeDefined();

    // Wait for the replica to have the original row before inducing lag,
    // so the "stale" read below is unambiguously about the UPDATE, not
    // about the INSERT itself still being in flight.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const check = await replicaPool.query("SELECT 1 FROM user_profiles WHERE id = $1", [profile!.id]);
      if ((check.rowCount ?? 0) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    await setReplicaApplyDelay(replicaPool, ARTIFICIAL_DELAY_MS);

    let staleCount = 0;
    const trials = 10;
    for (let i = 0; i < trials; i += 1) {
      const newName = `updated-name-${i}`;
      await primaryDb.update(userProfiles).set({ displayName: newName }).where(eq(userProfiles.id, profile!.id));

      const replicaResult = await replicaPool.query<{ display_name: string }>(
        "SELECT display_name FROM user_profiles WHERE id = $1",
        [profile!.id],
      );
      if (replicaResult.rows[0]?.display_name !== newName) {
        staleCount += 1;
      }
    }

    // This is a real, deliberately-induced, deterministic invariant: with a
    // 400ms recovery_min_apply_delay active and each trial's read happening
    // synchronously right after commit (well under 400ms), the replica
    // CANNOT have replayed the update yet. Every trial should be stale.
    expect(staleCount).toBe(trials);
  });
});
