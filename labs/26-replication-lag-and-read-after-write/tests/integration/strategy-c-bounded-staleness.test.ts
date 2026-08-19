import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { primaryDb, primaryPool, waitForDatabase as waitForPrimary } from "../../src/db/primary-client.js";
import { replicaPool, waitForDatabase as waitForReplica } from "../../src/db/replica-client.js";
import { userProfiles } from "../../src/db/schema.js";
import {
  getReplicationLagFromPrimary,
  setReplicaApplyDelay,
  waitForReplicationCaughtUp,
} from "../../src/lib/replication-control.js";

const ARTIFICIAL_DELAY_MS = 400;
const LAG_THRESHOLD_BYTES = 100;

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

async function routeOnce(id: number, expectedName: string): Promise<{ route: "primary" | "replica"; correct: boolean }> {
  // Same small, realistic write-to-read buffer as the scenario script - see
  // strategy-c-bounded-staleness.ts for why this avoids racing real,
  // non-delayed replication's own sub-millisecond confirmation window.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const lag = await getReplicationLagFromPrimary(primaryPool);
  const route: "primary" | "replica" = lag.replayLagBytes > LAG_THRESHOLD_BYTES ? "primary" : "replica";
  const pool = route === "primary" ? primaryPool : replicaPool;
  const result = await pool.query<{ display_name: string }>("SELECT display_name FROM user_profiles WHERE id = $1", [
    id,
  ]);
  return { route, correct: result.rows[0]?.display_name === expectedName };
}

describe("Strategy C - bounded staleness (byte-based backlog measurement)", () => {
  it("falls back to the primary on every trial when the real WAL backlog exceeds the threshold", async () => {
    const [profile] = await primaryDb
      .insert(userProfiles)
      .values({ displayName: "original-name", bio: "strategy-c high-lag test row" })
      .returning({ id: userProfiles.id });
    expect(profile).toBeDefined();

    await setReplicaApplyDelay(replicaPool, ARTIFICIAL_DELAY_MS);

    let fallbackCount = 0;
    let correctCount = 0;
    const trials = 8;
    for (let i = 0; i < trials; i += 1) {
      const newName = `bounded-staleness-high-lag-${i}`;
      await primaryDb.update(userProfiles).set({ displayName: newName }).where(eq(userProfiles.id, profile!.id));
      const { route, correct } = await routeOnce(profile!.id, newName);
      if (route === "primary") fallbackCount += 1;
      if (correct) correctCount += 1;
    }

    expect(fallbackCount).toBe(trials);
    expect(correctCount).toBe(trials);
  });

  it("does NOT fall back to the primary when the real WAL backlog is under the threshold", async () => {
    const [profile] = await primaryDb
      .insert(userProfiles)
      .values({ displayName: "original-name", bio: "strategy-c low-lag test row" })
      .returning({ id: userProfiles.id });
    expect(profile).toBeDefined();

    await setReplicaApplyDelay(replicaPool, 0);
    await waitForReplicationCaughtUp(primaryPool, { timeoutMs: 3_000 }).catch(() => {});

    let fallbackCount = 0;
    let correctCount = 0;
    const trials = 8;
    for (let i = 0; i < trials; i += 1) {
      const newName = `bounded-staleness-low-lag-${i}`;
      await primaryDb.update(userProfiles).set({ displayName: newName }).where(eq(userProfiles.id, profile!.id));
      const { route, correct } = await routeOnce(profile!.id, newName);
      if (route === "primary") fallbackCount += 1;
      if (correct) correctCount += 1;
    }

    expect(fallbackCount).toBe(0);
    expect(correctCount).toBe(trials);
  });
});
