import { afterAll, beforeAll, it, expect } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { seedOrders } from "../../src/seed/seed.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await pool.end();
});

it("seeding is deterministic and idempotent: same seed value produces the identical row count and guest-checkout count every time", async () => {
  await seedOrders(pool, 300, 38);
  const first = await pool.query("SELECT count(*)::int AS total, count(*) FILTER (WHERE customer_email IS NULL)::int AS guests FROM orders");

  await seedOrders(pool, 300, 38);
  const second = await pool.query("SELECT count(*)::int AS total, count(*) FILTER (WHERE customer_email IS NULL)::int AS guests FROM orders");

  expect(second.rows[0]).toEqual(first.rows[0]);
  expect(first.rows[0].total).toBe(300);
  expect(first.rows[0].guests).toBeGreaterThan(0);
});
