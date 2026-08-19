import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { primaryDb, primaryPool, waitForDatabase as waitForPrimary } from "../../src/db/primary-client.js";
import { replicaPool, waitForDatabase as waitForReplica } from "../../src/db/replica-client.js";
import { resetTopology, stopService } from "../../src/lib/docker-control.js";
import { attemptWrite, getReplicationStatus, isInRecovery, promote, waitUntilReachable } from "../../src/lib/replication-control.js";

const PRIMARY_URL = process.env.PRIMARY_DATABASE_URL!;
const REPLICA_URL = process.env.REPLICA_DATABASE_URL!;

// THIS is the one test file in this lab that genuinely stops a container and
// promotes the other. Its `beforeAll` does not assume any particular prior
// state beyond "both containers are up" (see vitest.config.ts's comment on
// why file order is not assumed), and its `afterAll` performs a full, real
// `docker compose down -v && up -d` reset so the topology is fresh, healthy,
// and non-promoted again afterward - both for a human running `pnpm test`
// interactively and for any test file that runs after this one.
beforeAll(async () => {
  await waitForPrimary(primaryPool);
  await migrate(primaryDb, { migrationsFolder: "drizzle" });
  await waitForReplica(replicaPool);
});

afterAll(async () => {
  await resetTopology();
  await waitUntilReachable(PRIMARY_URL, { timeoutMs: 90_000 });
  await waitUntilReachable(REPLICA_URL, { timeoutMs: 90_000 });
}, 120_000);

describe("real failover: stop the primary, promote the standby", () => {
  it(
    "flips pg_is_in_recovery() from true to false and lets a write succeed that was previously rejected with SQLSTATE 25006",
    async () => {
      // Baseline, confirmed once more right before the destructive part.
      const before = await getReplicationStatus(primaryPool);
      expect(before).toHaveLength(1);
      await expect(isInRecovery(replicaPool)).resolves.toBe(true);

      const rejectedBefore = await attemptWrite(REPLICA_URL, "test-should-be-rejected-before-promotion", 1);
      expect(rejectedBefore.ok).toBe(false);
      expect(rejectedBefore.sqlState).toBe("25006");

      // Close the pool BEFORE stopping its container - see
      // failover-and-promote.ts's comment on why a long-lived Pool must not
      // be left pointed at a container that is about to disappear.
      await primaryPool.end();

      await stopService("primary");

      const failedWrite = await attemptWrite(PRIMARY_URL, "test-should-fail-primary-is-down", 1);
      expect(failedWrite.ok).toBe(false);
      expect(failedWrite.connectionErrorCode).toBeDefined();

      const promotion = await promote(replicaPool, 60);
      expect(promotion.promoted).toBe(true);

      await expect(isInRecovery(replicaPool)).resolves.toBe(false);

      let accepted = await attemptWrite(REPLICA_URL, "test-accepted-after-promotion", 2);
      let retries = 0;
      while (!accepted.ok && retries < 20) {
        retries += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        accepted = await attemptWrite(REPLICA_URL, "test-accepted-after-promotion", 2);
      }
      expect(accepted.ok).toBe(true);
    },
    120_000,
  );
});
