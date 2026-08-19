import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { primaryDb, primaryPool, waitForDatabase as waitForPrimary } from "../../src/db/primary-client.js";
import { replicaPool, waitForDatabase as waitForReplica } from "../../src/db/replica-client.js";
import { widgets } from "../../src/db/schema.js";
import { getReplicationStatus, isInRecovery } from "../../src/lib/replication-control.js";

// This file is intentionally NON-destructive - no container is stopped or
// promoted here. It is written to pass regardless of whether it runs before
// or after failover-promotion.test.ts (Vitest file discovery order is not
// guaranteed to be alphabetical - see vitest.config.ts's comment) since
// failover-promotion.test.ts's own `afterAll` always leaves the cluster back
// in a fresh, healthy, non-promoted state.
beforeAll(async () => {
  await waitForPrimary(primaryPool);
  await migrate(primaryDb, { migrationsFolder: "drizzle" });
  await waitForReplica(replicaPool);
});

afterAll(async () => {
  await primaryPool.end();
  await replicaPool.end();
});

describe("baseline two-node primary/standby topology", () => {
  it("the primary sees exactly one streaming replica", async () => {
    const rows = await getReplicationStatus(primaryPool);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("streaming");
  });

  it("pg_is_in_recovery() correctly distinguishes primary (false) from standby (true)", async () => {
    await expect(isInRecovery(primaryPool)).resolves.toBe(false);
    await expect(isInRecovery(replicaPool)).resolves.toBe(true);
  });

  it("a row written on the primary replicates to the standby", async () => {
    const [inserted] = await primaryDb
      .insert(widgets)
      .values({ name: "baseline-test-row", value: 1 })
      .returning({ publicId: widgets.publicId });
    expect(inserted).toBeDefined();

    const deadline = Date.now() + 5_000;
    let found = false;
    while (Date.now() < deadline) {
      const result = await replicaPool.query("SELECT 1 FROM widgets WHERE public_id = $1", [inserted!.publicId]);
      if ((result.rowCount ?? 0) > 0) {
        found = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(found).toBe(true);
  });

  it("the standby rejects a direct write with SQLSTATE 25006", async () => {
    await expect(
      replicaPool.query("INSERT INTO widgets (name, value) VALUES ($1, $2)", ["should-never-exist", 1]),
    ).rejects.toMatchObject({ code: "25006" });
  });
});
