import { avg, eq, gt, notExists, sum } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { customers, orderLines, orders, products } from "../db/schema.js";

const log = createLogger("lab03:demo:subqueries");

/**
 * Two subquery shapes:
 *
 * 1. A scalar subquery in a WHERE clause: customers whose total revenue is
 *    above the average customer's revenue (average computed over customers
 *    who have ordered at least once).
 * 2. An anti-join via NOT EXISTS: products that have never appeared in any
 *    order_line. `NOT EXISTS` is generally preferred over `NOT IN` for this
 *    in Postgres - `NOT IN` against a subquery that could contain a NULL
 *    silently returns zero rows for the whole query, which is a classic
 *    footgun `NOT EXISTS` does not share.
 */
async function main() {
  await waitForDatabase(pool);

  // --- 1. Customers above average customer revenue ---

  const customerRevenue = db.$with("customer_revenue").as(
    db
      .select({
        customerId: orders.customerId,
        revenueCents: sum(orderLines.lineTotalCents).as("revenue_cents"),
      })
      .from(orders)
      .innerJoin(orderLines, eq(orderLines.orderId, orders.id))
      .groupBy(orders.customerId),
  );

  const averageRevenueSubquery = db
    .with(customerRevenue)
    .select({ avgRevenueCents: avg(customerRevenue.revenueCents) })
    .from(customerRevenue);

  const aboveAverage = await db
    .with(customerRevenue)
    .select({
      customerName: customers.fullName,
      revenueCents: customerRevenue.revenueCents,
    })
    .from(customerRevenue)
    .innerJoin(customers, eq(customers.id, customerRevenue.customerId))
    .where(gt(customerRevenue.revenueCents, averageRevenueSubquery))
    .orderBy(customerRevenue.revenueCents);

  log.info(
    { count: aboveAverage.length, sample: aboveAverage.slice(0, 5) },
    "Drizzle: customers spending above the average customer (scalar subquery in WHERE)",
  );

  const rawAboveAverage = await pool.query(
    `WITH customer_revenue AS (
       SELECT o.customer_id, sum(ol.line_total_cents) AS revenue_cents
       FROM orders o
       JOIN order_lines ol ON ol.order_id = o.id
       GROUP BY o.customer_id
     )
     SELECT c.full_name AS "customerName", cr.revenue_cents AS "revenueCents"
     FROM customer_revenue cr
     JOIN customers c ON c.id = cr.customer_id
     WHERE cr.revenue_cents > (SELECT avg(revenue_cents) FROM customer_revenue)
     ORDER BY cr.revenue_cents`,
  );

  log.info(
    {
      drizzleCount: aboveAverage.length,
      rawCount: rawAboveAverage.rowCount,
      agree: aboveAverage.length === rawAboveAverage.rowCount,
    },
    "raw SQL: same query, row counts agree",
  );

  // --- 2. Products never ordered (NOT EXISTS anti-join) ---

  const drizzleNeverOrdered = await db
    .select({ id: products.id, name: products.name, category: products.category })
    .from(products)
    .where(
      notExists(
        db
          .select({ one: orderLines.id })
          .from(orderLines)
          .where(eq(orderLines.productId, products.id)),
      ),
    )
    .orderBy(products.id);

  log.info(
    { count: drizzleNeverOrdered.length, sample: drizzleNeverOrdered.slice(0, 5) },
    "Drizzle: products never ordered (NOT EXISTS)",
  );

  const rawNeverOrdered = await pool.query(
    `SELECT p.id, p.name, p.category
     FROM products p
     WHERE NOT EXISTS (
       SELECT 1 FROM order_lines ol WHERE ol.product_id = p.id
     )
     ORDER BY p.id`,
  );

  log.info(
    {
      drizzleCount: drizzleNeverOrdered.length,
      rawCount: rawNeverOrdered.rowCount,
      agree: drizzleNeverOrdered.length === rawNeverOrdered.rowCount,
    },
    "raw SQL: same query, row counts agree",
  );

  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ error }, "subqueries demo failed");
  process.exit(1);
});
