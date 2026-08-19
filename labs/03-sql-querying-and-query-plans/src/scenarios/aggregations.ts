import { countDistinct, desc, eq, sum } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { customers, orderLines, orders, products } from "../db/schema.js";

const log = createLogger("lab03:demo:aggregations");

/**
 * Two GROUP BY aggregations:
 *
 * 1. Revenue and order count per customer. Note the `countDistinct(orders.id)`
 *    here, not `count(orders.id)` - because this query joins through
 *    order_lines, each order appears once per line it has, so a plain
 *    `count(orders.id)` would overcount orders with more than one line. See
 *    README "Break it" / "Fix it" for the full failure mode this sidesteps.
 * 2. Revenue and average unit price per product category - a simpler
 *    aggregation with no fan-out risk (order_lines -> products is many-to-one).
 */
async function main() {
  await waitForDatabase(pool);

  // --- 1. Revenue + order count per customer ---

  const drizzleCustomerRevenue = await db
    .select({
      customerId: customers.id,
      customerName: customers.fullName,
      orderCount: countDistinct(orders.id),
      revenueCents: sum(orderLines.lineTotalCents),
    })
    .from(customers)
    .innerJoin(orders, eq(orders.customerId, customers.id))
    .innerJoin(orderLines, eq(orderLines.orderId, orders.id))
    .groupBy(customers.id, customers.fullName)
    .orderBy(desc(sum(orderLines.lineTotalCents)))
    .limit(5);

  log.info({ top5: drizzleCustomerRevenue }, "Drizzle: revenue + order count per customer (top 5)");

  const rawCustomerRevenue = await pool.query(
    `SELECT
       c.id                          AS "customerId",
       c.full_name                   AS "customerName",
       count(DISTINCT o.id)          AS "orderCount",
       sum(ol.line_total_cents)      AS "revenueCents"
     FROM customers c
     JOIN orders o      ON o.customer_id = c.id
     JOIN order_lines ol ON ol.order_id = o.id
     GROUP BY c.id, c.full_name
     ORDER BY sum(ol.line_total_cents) DESC
     LIMIT 5`,
  );

  log.info({ top5: rawCustomerRevenue.rows }, "raw SQL: revenue + order count per customer (top 5)");

  // --- 2. Revenue + average price per product category ---

  const drizzleCategoryRevenue = await db
    .select({
      category: products.category,
      revenueCents: sum(orderLines.lineTotalCents),
    })
    .from(orderLines)
    .innerJoin(products, eq(orderLines.productId, products.id))
    .groupBy(products.category)
    .orderBy(desc(sum(orderLines.lineTotalCents)));

  log.info({ byCategory: drizzleCategoryRevenue }, "Drizzle: revenue per product category");

  const rawCategoryRevenue = await pool.query(
    `SELECT
       p.category,
       sum(ol.line_total_cents) AS "revenueCents"
     FROM order_lines ol
     JOIN products p ON p.id = ol.product_id
     GROUP BY p.category
     ORDER BY sum(ol.line_total_cents) DESC`,
  );

  log.info({ byCategory: rawCategoryRevenue.rows }, "raw SQL: revenue per product category");

  log.info(
    {
      drizzleCategories: drizzleCategoryRevenue.length,
      rawCategories: rawCategoryRevenue.rowCount,
      agree: drizzleCategoryRevenue.length === rawCategoryRevenue.rowCount,
    },
    "category aggregation row counts agree",
  );

  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ error }, "aggregations demo failed");
  process.exit(1);
});
