import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { primaryDb, primaryPool, waitForDatabase as waitForPrimary } from "../../src/db/primary-client.js";
import { replicaPool, waitForDatabase as waitForReplica } from "../../src/db/replica-client.js";
import { widgets } from "../../src/db/schema.js";

beforeAll(async () => {
  await waitForPrimary(primaryPool);
  await migrate(primaryDb, { migrationsFolder: "drizzle" });
  await waitForReplica(replicaPool);
});

afterAll(async () => {
  await primaryPool.end();
  await replicaPool.end();
});

const POLL_INTERVAL_MS = 20;
const POLL_TIMEOUT_MS = 5_000;

describe("primary -> replica physical replication", () => {
  it("a row written to the primary eventually appears on the replica", async () => {
    const [inserted] = await primaryDb
      .insert(widgets)
      .values({ name: "replication-test-row", value: 1 })
      .returning({ publicId: widgets.publicId });

    expect(inserted).toBeDefined();
    const publicId = inserted!.publicId;

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let found = false;
    while (Date.now() < deadline) {
      const result = await replicaPool.query("SELECT 1 FROM widgets WHERE public_id = $1", [publicId]);
      if ((result.rowCount ?? 0) > 0) {
        found = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    // This is inherently a bit timing-dependent since it exercises real
    // async streaming replication - the bound is generous (5s) rather than
    // tight, per SPEC.md section 11 ("assert on eventual consistency within
    // a generous bound, not a tight one").
    expect(found).toBe(true);
  });

  it("pg_stat_replication on the primary shows exactly one connected replica in a valid state", async () => {
    const result = await primaryPool.query<{ state: string; application_name: string }>(
      "SELECT state, application_name FROM pg_stat_replication",
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0]?.state).toBe("streaming");
  });
});
