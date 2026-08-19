import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { primaryDb, primaryPool, waitForDatabase } from "../../src/db/primary-client.js";
import { widgets } from "../../src/db/schema.js";

beforeAll(async () => {
  await waitForDatabase(primaryPool);
  await migrate(primaryDb, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await primaryPool.end();
});

describe("WAL / LSN mechanics on the primary", () => {
  it("pg_current_wal_lsn() strictly increases after a write, per pg_wal_lsn_diff", async () => {
    const before = await primaryPool.query<{ lsn: string }>("SELECT pg_current_wal_lsn() AS lsn");
    const lsnBefore = before.rows[0]?.lsn;

    await primaryDb.insert(widgets).values({ name: "lsn-test-row", value: 1 });

    const after = await primaryPool.query<{ lsn: string }>("SELECT pg_current_wal_lsn() AS lsn");
    const lsnAfter = after.rows[0]?.lsn;

    const diff = await primaryPool.query<{ bytes: string }>("SELECT pg_wal_lsn_diff($1, $2) AS bytes", [
      lsnAfter,
      lsnBefore,
    ]);

    expect(Number(diff.rows[0]?.bytes)).toBeGreaterThan(0);
  });
});
