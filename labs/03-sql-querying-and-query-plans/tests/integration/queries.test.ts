import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, isNull, notExists, sum } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { customers, orderLines, orders, products } from "../../src/db/schema.js";
import { seedTestData } from "./seed-helper.js";

/**
 * These tests exist to protect a specific invariant this lab teaches: the
 * Drizzle query builder and hand-written SQL against the same tables must
 * agree. If they ever disagree, either the Drizzle query was built wrong or
 * the raw SQL was transcribed wrong - both are bugs worth catching before a
 * learner trusts either version.
 */
beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await seedTestData();
});

afterAll(async () => {
  await pool.end();
});

describe("joins: Drizzle vs raw SQL", () => {
  it("inner join across customers/orders/order_lines/products agrees on row count and content", async () => {
    const drizzleRows = await db
      .select({
        orderPublicId: orders.publicId,
        customerName: customers.fullName,
        productName: products.name,
        quantity: orderLines.quantity,
        lineTotalCents: orderLines.lineTotalCents,
      })
      .from(orderLines)
      .innerJoin(orders, eq(orderLines.orderId, orders.id))
      .innerJoin(customers, eq(orders.customerId, customers.id))
      .innerJoin(products, eq(orderLines.productId, products.id))
      .orderBy(orderLines.id);

    const rawResult = await pool.query(
      `SELECT
         o.public_id  AS "orderPublicId",
         c.full_name  AS "customerName",
         p.name       AS "productName",
         ol.quantity,
         ol.line_total_cents AS "lineTotalCents"
       FROM order_lines ol
       JOIN orders o    ON o.id = ol.order_id
       JOIN customers c ON c.id = o.customer_id
       JOIN products p  ON p.id = ol.product_id
       ORDER BY ol.id`,
    );

    expect(drizzleRows.length).toBeGreaterThan(0);
    expect(drizzleRows.length).toBe(rawResult.rowCount);
    expect(drizzleRows).toEqual(rawResult.rows);
  });

  it("left join for customers with zero orders agrees between Drizzle and raw SQL", async () => {
    const drizzleRows = await db
      .select({ id: customers.id })
      .from(customers)
      .leftJoin(orders, eq(orders.customerId, customers.id))
      .where(isNull(orders.id));

    // c.id is cast to ::int here because node-postgres returns bigint (int8)
    // columns as strings by default (to avoid silently losing precision past
    // Number.MAX_SAFE_INTEGER), while Drizzle's bigint(mode: "number")
    // columns come back as plain numbers - a real type mismatch worth
    // knowing about, not just a test-comparison inconvenience. See README
    // "Observe".
    const rawResult = await pool.query(
      `SELECT c.id::int AS id
       FROM customers c
       LEFT JOIN orders o ON o.customer_id = c.id
       WHERE o.id IS NULL`,
    );

    const drizzleIds = drizzleRows.map((r) => r.id).sort((a, b) => a - b);
    const rawIds = rawResult.rows.map((r: { id: number }) => r.id).sort((a, b) => a - b);

    expect(drizzleIds).toEqual(rawIds);
  });
});

describe("aggregations: Drizzle vs raw SQL", () => {
  it("revenue per product category agrees between Drizzle and raw SQL", async () => {
    const drizzleRows = await db
      .select({
        category: products.category,
        revenueCents: sum(orderLines.lineTotalCents),
      })
      .from(orderLines)
      .innerJoin(products, eq(orderLines.productId, products.id))
      .groupBy(products.category)
      .orderBy(products.category);

    const rawResult = await pool.query(
      `SELECT p.category, sum(ol.line_total_cents) AS "revenueCents"
       FROM order_lines ol
       JOIN products p ON p.id = ol.product_id
       GROUP BY p.category
       ORDER BY p.category`,
    );

    expect(drizzleRows.length).toBeGreaterThan(0);
    expect(drizzleRows).toEqual(rawResult.rows);
  });
});

describe("subqueries: Drizzle vs raw SQL", () => {
  it("NOT EXISTS anti-join for products never ordered agrees between Drizzle and raw SQL", async () => {
    const drizzleRows = await db
      .select({ id: products.id })
      .from(products)
      .where(
        notExists(
          db.select({ one: orderLines.id }).from(orderLines).where(eq(orderLines.productId, products.id)),
        ),
      )
      .orderBy(products.id);

    // Cast for the same reason as the left-join test above: raw pg returns
    // bigint as a string.
    const rawResult = await pool.query(
      `SELECT p.id::int AS id
       FROM products p
       WHERE NOT EXISTS (SELECT 1 FROM order_lines ol WHERE ol.product_id = p.id)
       ORDER BY p.id`,
    );

    expect(drizzleRows.map((r) => r.id)).toEqual(rawResult.rows.map((r: { id: number }) => r.id));
  });
});
