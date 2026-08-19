import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { primaryDb, primaryPool, waitForDatabase as waitForPrimary } from "../../src/db/primary-client.js";
import { replica1Pool, waitForDatabase as waitForReplica1 } from "../../src/db/replica1-client.js";
import { replica2Pool, waitForDatabase as waitForReplica2 } from "../../src/db/replica2-client.js";
import { widgets } from "../../src/db/schema.js";
import { getDownstreamReplicationStats } from "../../src/lib/replication-control.js";

beforeAll(async () => {
  await waitForPrimary(primaryPool);
  await migrate(primaryDb, { migrationsFolder: "drizzle" });
  await waitForReplica1(replica1Pool);
  await waitForReplica2(replica2Pool);
});

afterAll(async () => {
  await primaryPool.end();
  await replica1Pool.end();
  await replica2Pool.end();
});

const POLL_INTERVAL_MS = 20;
const POLL_TIMEOUT_MS = 15_000;

describe("cascading topology: primary -> replica-1 -> replica-2", () => {
  it("pg_stat_replication on the PRIMARY shows exactly one connected downstream node (replica-1)", async () => {
    const rows = await getDownstreamReplicationStats(primaryPool);
    expect(rows.length).toBe(1);
    expect(rows[0]?.state).toBe("streaming");
  });

  it("pg_stat_replication on REPLICA-1 shows exactly one connected downstream node (replica-2)", async () => {
    const rows = await getDownstreamReplicationStats(replica1Pool);
    expect(rows.length).toBe(1);
    expect(rows[0]?.state).toBe("streaming");
  });

  it("pg_stat_replication on REPLICA-2 shows zero connected downstream nodes - it is a leaf", async () => {
    const rows = await getDownstreamReplicationStats(replica2Pool);
    expect(rows.length).toBe(0);
  });

  it("both replica-1 and replica-2 report pg_is_in_recovery() = true", async () => {
    const r1 = await replica1Pool.query<{ pg_is_in_recovery: boolean }>("SELECT pg_is_in_recovery()");
    const r2 = await replica2Pool.query<{ pg_is_in_recovery: boolean }>("SELECT pg_is_in_recovery()");
    expect(r1.rows[0]?.pg_is_in_recovery).toBe(true);
    expect(r2.rows[0]?.pg_is_in_recovery).toBe(true);
  });

  it("a row written to the primary eventually appears on replica-1 AND on replica-2", async () => {
    const [inserted] = await primaryDb
      .insert(widgets)
      .values({ name: "cascade-topology-test-row", value: 1 })
      .returning({ publicId: widgets.publicId });

    expect(inserted).toBeDefined();
    const publicId = inserted!.publicId;

    for (const pool of [replica1Pool, replica2Pool]) {
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let found = false;
      while (Date.now() < deadline) {
        const result = await pool.query("SELECT 1 FROM widgets WHERE public_id = $1", [publicId]);
        if ((result.rowCount ?? 0) > 0) {
          found = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      expect(found).toBe(true);
    }
  });

  it("replica-2 never connects to the primary directly - only replica-1 does", async () => {
    // The primary's pg_stat_replication application_name reflects whatever
    // connected to IT - since replica-2's connection string points at
    // replica-1, not the primary, the primary's row set can never include a
    // second entry no matter how many nodes exist further down the chain.
    const rows = await getDownstreamReplicationStats(primaryPool);
    expect(rows.length).toBe(1);
  });
});
