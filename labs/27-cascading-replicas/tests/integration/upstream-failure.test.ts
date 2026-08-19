import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { primaryDb, primaryPool, waitForDatabase as waitForPrimary } from "../../src/db/primary-client.js";
import { replica1Pool, waitForDatabase as waitForReplica1 } from "../../src/db/replica1-client.js";
import { replica2Pool, waitForDatabase as waitForReplica2 } from "../../src/db/replica2-client.js";
import { widgets } from "../../src/db/schema.js";
import { getDownstreamReplicationStats, waitForRowVisible } from "../../src/lib/replication-control.js";
import { startContainer, stopContainer, waitForContainerHealthy } from "../../src/lib/docker-control.js";

const REPLICA1_CONTAINER = "lab27-replica-1";

beforeAll(async () => {
  await waitForPrimary(primaryPool);
  await migrate(primaryDb, { migrationsFolder: "drizzle" });
  await waitForReplica1(replica1Pool);
  await waitForReplica2(replica2Pool);
});

afterAll(async () => {
  // Belt-and-braces: make sure replica-1 is left running and healthy for any
  // later test file or manual inspection, even if an assertion above failed
  // mid-test.
  await startContainer(REPLICA1_CONTAINER).catch(() => undefined);
  await waitForContainerHealthy(REPLICA1_CONTAINER, { timeoutMs: 60_000 }).catch(() => undefined);
  await primaryPool.end();
  await replica1Pool.end();
  await replica2Pool.end();
});

describe("upstream (middle-tier) replica failure - a real, genuine container stop/start", () => {
  it(
    "when replica-1 is stopped, replica-2 stops receiving new writes entirely, then catches up automatically once replica-1 resumes",
    async () => {
      const [before] = await primaryDb
        .insert(widgets)
        .values({ name: "upstream-failure-test-before", value: 1 })
        .returning({ publicId: widgets.publicId });
      expect(before).toBeDefined();
      await waitForRowVisible(replica2Pool, before!.publicId, { timeoutMs: 10_000 });

      await stopContainer(REPLICA1_CONTAINER);

      const primaryDownstreamDuringOutage = await getDownstreamReplicationStats(primaryPool);
      expect(primaryDownstreamDuringOutage.length).toBe(0);

      const [during] = await primaryDb
        .insert(widgets)
        .values({ name: "upstream-failure-test-during", value: 2 })
        .returning({ publicId: widgets.publicId });
      expect(during).toBeDefined();

      // Real observation window - long enough that if replica-2 somehow had
      // an alternate path to the primary, it would have shown up by now.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const duringOutageCheck = await replica2Pool.query("SELECT 1 FROM widgets WHERE public_id = $1", [
        during!.publicId,
      ]);
      expect(duringOutageCheck.rowCount ?? 0).toBe(0);

      await startContainer(REPLICA1_CONTAINER);
      await waitForContainerHealthy(REPLICA1_CONTAINER, { timeoutMs: 60_000 });
      await waitForReplica1(replica1Pool);

      await waitForRowVisible(replica1Pool, during!.publicId, { timeoutMs: 30_000 });
      await waitForRowVisible(replica2Pool, during!.publicId, { timeoutMs: 30_000 });

      const primaryDownstreamAfterRecovery = await getDownstreamReplicationStats(primaryPool);
      expect(primaryDownstreamAfterRecovery.length).toBe(1);
    },
    90_000,
  );
});
