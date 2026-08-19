import { afterAll, beforeAll, it, expect } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { seedOrders } from "../../src/seed/seed.js";
import { loadSharedSql } from "../../src/observability/db-sql.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
}
const connectionString = process.env.DATABASE_URL;

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await seedOrders(pool, 50, 38);
});

afterAll(async () => {
  await pool.end();
});

/**
 * Proves this lab's real concurrent-activity scenario against the SHARED
 * `packages/db-utils/sql/*.sql` scripts, not a re-implementation of them -
 * a genuine row-lock holder really does block a genuine concurrent writer,
 * and `show-blocked-queries.sql` really does surface both PIDs correctly
 * paired.
 */
it("show-blocked-queries.sql reports a real blocked writer against a real lock holder, correctly paired by PID", async () => {
  const holder = new Client({ connectionString });
  const writer = new Client({ connectionString });
  await holder.connect();
  await writer.connect();

  try {
    const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;

    await holder.query("BEGIN");
    await holder.query("SELECT * FROM orders WHERE id = 1 FOR UPDATE");

    // Fire the blocked writer without awaiting - it must genuinely hang
    // until the holder releases its lock.
    const writerPromise = writer
      .query("BEGIN")
      .then(() => writer.query("UPDATE orders SET status = 'pending' WHERE id = 1"))
      .then(() => writer.query("COMMIT"));

    // Give the writer time to actually issue its UPDATE and start waiting.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const blockedResult = await pool.query(loadSharedSql("show-blocked-queries.sql"));
    const relevantRow = blockedResult.rows.find(
      (row: { blocked_pid: number; blocking_pid: number }) => row.blocked_pid === writerPid,
    );

    expect(relevantRow).toBeDefined();
    expect(relevantRow.blocking_pid).toBe(holderPid);
    expect(relevantRow.blocked_query).toContain("UPDATE");

    await holder.query("ROLLBACK");
    await writerPromise;
    await writer.query("ROLLBACK").catch(() => {});
  } finally {
    await holder.end();
    await writer.end();
  }
});

it("show-active-transactions.sql reports a real long-running transaction while it is still open", async () => {
  const longRunner = new Client({ connectionString });
  await longRunner.connect();

  try {
    const pid = (await longRunner.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    await longRunner.query("BEGIN");
    const sleepPromise = longRunner.query("SELECT pg_sleep(1.5)");

    await new Promise((resolve) => setTimeout(resolve, 300));
    const activeResult = await pool.query(loadSharedSql("show-active-transactions.sql"));
    const row = activeResult.rows.find((r: { pid: number }) => r.pid === pid);
    expect(row).toBeDefined();
    expect(row.query).toContain("pg_sleep");

    await sleepPromise;
    await longRunner.query("ROLLBACK");
  } finally {
    await longRunner.end();
  }
});
