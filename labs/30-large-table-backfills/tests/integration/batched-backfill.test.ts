import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { orders } from "../../src/db/schema.js";
import { backfillLoyaltyPoints } from "../../src/scenarios/batched-resumable-backfill.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await pool.end();
});

/**
 * `backfillLoyaltyPoints` operates on the WHOLE `orders` table (the same way
 * a real production backfill script would), so every test here truncates and
 * seeds its own small, fully-controlled dataset first - the same isolation
 * rationale Lab 29's tests document, just applied at the table level instead
 * of per-row, since this function's `WHERE loyalty_points IS NULL` predicate
 * is deliberately global.
 */
async function resetOrders(rowCount: number): Promise<void> {
  await pool.query("TRUNCATE TABLE orders RESTART IDENTITY");
  const emails = Array.from({ length: rowCount }, (_, i) => `test-${i}@example.com`);
  const amounts = Array.from({ length: rowCount }, (_, i) => 1_000 + i * 37);
  const statuses = Array.from({ length: rowCount }, () => "paid");
  await pool.query(
    `INSERT INTO orders (customer_email, amount_cents, status)
     SELECT * FROM unnest($1::text[], $2::int[], $3::text[])`,
    [emails, amounts, statuses],
  );
}

describe("batched, resumable backfill: correctness", () => {
  it("backfills every row with the correct computed value, across multiple batches", async () => {
    await resetOrders(37);

    const result = await backfillLoyaltyPoints(pool, { batchSize: 10, sleepMs: 0 });

    expect(result.batches).toBe(4); // 10, 10, 10, 7
    expect(result.rowsBackfilled).toBe(37);

    const rows = await db.select().from(orders);
    expect(rows).toHaveLength(37);
    for (const row of rows) {
      expect(row.loyaltyPoints).toBe(Math.floor(row.amountCents / 100));
    }
  });

  it("running again on a fully backfilled table does no work", async () => {
    const result = await backfillLoyaltyPoints(pool, { batchSize: 10, sleepMs: 0 });
    expect(result.batches).toBe(0);
    expect(result.rowsBackfilled).toBe(0);
  });

  it("is resumable: an interrupted run leaves partial state that a second run completes with no double-processing and no skipped rows", async () => {
    await resetOrders(25);

    await expect(backfillLoyaltyPoints(pool, { batchSize: 5, sleepMs: 0, maxBatches: 2 })).rejects.toThrow(
      /simulated crash/,
    );

    const midway = await pool.query<{ pending: string; backfilled: string }>(
      `SELECT count(*) FILTER (WHERE loyalty_points IS NULL) AS pending,
              count(*) FILTER (WHERE loyalty_points IS NOT NULL) AS backfilled
       FROM orders`,
    );
    expect(Number(midway.rows[0]!.backfilled)).toBe(10); // 2 batches * 5 rows
    expect(Number(midway.rows[0]!.pending)).toBe(15);

    const resumed = await backfillLoyaltyPoints(pool, { batchSize: 5, sleepMs: 0 });
    expect(resumed.rowsBackfilled).toBe(15);
    expect(resumed.batches).toBe(3); // 5, 5, 5

    const final = await pool.query<{ pending: string }>(
      `SELECT count(*) FILTER (WHERE loyalty_points IS NULL) AS pending FROM orders`,
    );
    expect(Number(final.rows[0]!.pending)).toBe(0);

    const rows = await db.select().from(orders);
    for (const row of rows) {
      expect(row.loyaltyPoints).toBe(Math.floor(row.amountCents / 100));
    }
  });

  it("resuming never re-touches an already-backfilled row (sentinel check)", async () => {
    await resetOrders(6);

    // Simulate "a previous run already handled this row" with a sentinel
    // value a fresh backfill would never produce (it only ever computes
    // floor(amount_cents / 100)) - if a rerun wrongly re-touches this row,
    // this assertion catches it immediately, the same technique Lab 29's
    // resumability test uses.
    await db.update(orders).set({ loyaltyPoints: 999_999 }).where(sql`id = 1`);

    const result = await backfillLoyaltyPoints(pool, { batchSize: 2, sleepMs: 0 });
    expect(result.rowsBackfilled).toBe(5); // everything except the sentinel row

    const [sentinelRow] = await db.select().from(orders).where(sql`id = 1`);
    expect(sentinelRow?.loyaltyPoints).toBe(999_999);
  });
});
