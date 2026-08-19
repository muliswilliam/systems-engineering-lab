import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { primaryDb, primaryPool, waitForDatabase as waitForPrimary } from "../../src/db/primary-client.js";
import { replicaPool, waitForDatabase as waitForReplica } from "../../src/db/replica-client.js";
import { userProfiles } from "../../src/db/schema.js";
import { getPrimaryWalLsn, setReplicaApplyDelay, waitForReplicaLsnAtLeast } from "../../src/lib/replication-control.js";

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

describe("Strategy B - LSN-gated read", () => {
  it("blocks roughly as long as the real induced delay, then returns the correct value", async () => {
    const [profile] = await primaryDb
      .insert(userProfiles)
      .values({ displayName: "original-name", bio: "strategy-b test row" })
      .returning({ id: userProfiles.id });
    expect(profile).toBeDefined();

    await setReplicaApplyDelay(replicaPool, ARTIFICIAL_DELAY_MS);

    const newName = "lsn-gated-update";
    await primaryDb.update(userProfiles).set({ displayName: newName }).where(eq(userProfiles.id, profile!.id));

    const writeLsn = await getPrimaryWalLsn(primaryPool);
    const { waitedMs } = await waitForReplicaLsnAtLeast(replicaPool, writeLsn, { timeoutMs: 5_000 });

    const result = await replicaPool.query<{ display_name: string }>(
      "SELECT display_name FROM user_profiles WHERE id = $1",
      [profile!.id],
    );

    expect(result.rows[0]?.display_name).toBe(newName);
    // Generous bounds - this is real timing, not a mock. It should be in
    // the neighborhood of the configured 400ms delay, not near-zero and not
    // wildly larger.
    expect(waitedMs).toBeGreaterThan(ARTIFICIAL_DELAY_MS * 0.5);
    expect(waitedMs).toBeLessThan(ARTIFICIAL_DELAY_MS * 3);
  });

  it("waits only a small amount when there is no artificial delay", async () => {
    const [profile] = await primaryDb
      .insert(userProfiles)
      .values({ displayName: "original-name", bio: "strategy-b fast-path test row" })
      .returning({ id: userProfiles.id });
    expect(profile).toBeDefined();

    await setReplicaApplyDelay(replicaPool, 0);

    const newName = "lsn-gated-fast-update";
    await primaryDb.update(userProfiles).set({ displayName: newName }).where(eq(userProfiles.id, profile!.id));

    const writeLsn = await getPrimaryWalLsn(primaryPool);
    const { waitedMs } = await waitForReplicaLsnAtLeast(replicaPool, writeLsn, { timeoutMs: 5_000 });

    const result = await replicaPool.query<{ display_name: string }>(
      "SELECT display_name FROM user_profiles WHERE id = $1",
      [profile!.id],
    );

    expect(result.rows[0]?.display_name).toBe(newName);
    expect(waitedMs).toBeLessThan(200);
  });
});
