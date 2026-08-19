import { desc, eq, sum } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { customers, orderLines, orders } from "../db/schema.js";

const log = createLogger("lab03:demo:ctes");

/**
 * A two-step report built from two chained CTEs:
 *
 *   order_totals     - one row per order, order_lines pre-aggregated
 *   customer_revenue - one row per customer, order_totals aggregated up
 *
 * Pre-aggregating order_lines into order_totals *before* joining to
 * customers is exactly the technique this lab's "Break it" / "Fix it"
 * section relies on - a CTE makes the "aggregate first, then join" order of
 * operations explicit and readable instead of implicit in a single giant
 * GROUP BY.
 */
async function main() {
  await waitForDatabase(pool);

  const orderTotals = db.$with("order_totals").as(
    db
      .select({
        orderId: orderLines.orderId,
        orderRevenueCents: sum(orderLines.lineTotalCents).as("order_revenue_cents"),
      })
      .from(orderLines)
      .groupBy(orderLines.orderId),
  );

  const customerRevenue = db.$with("customer_revenue").as(
    db
      .with(orderTotals)
      .select({
        customerId: orders.customerId,
        revenueCents: sum(orderTotals.orderRevenueCents).as("revenue_cents"),
      })
      .from(orders)
      .innerJoin(orderTotals, eq(orderTotals.orderId, orders.id))
      .groupBy(orders.customerId),
  );

  const drizzleTop5 = await db
    .with(orderTotals, customerRevenue)
    .select({
      customerName: customers.fullName,
      revenueCents: customerRevenue.revenueCents,
    })
    .from(customerRevenue)
    .innerJoin(customers, eq(customers.id, customerRevenue.customerId))
    .orderBy(desc(customerRevenue.revenueCents))
    .limit(5);

  log.info({ top5: drizzleTop5 }, "Drizzle: top 5 customers by revenue (two chained CTEs)");

  const rawResult = await pool.query(
    `WITH order_totals AS (
       SELECT order_id, sum(line_total_cents) AS order_revenue_cents
       FROM order_lines
       GROUP BY order_id
     ),
     customer_revenue AS (
       SELECT o.customer_id, sum(ot.order_revenue_cents) AS revenue_cents
       FROM orders o
       JOIN order_totals ot ON ot.order_id = o.id
       GROUP BY o.customer_id
     )
     SELECT c.full_name AS "customerName", cr.revenue_cents AS "revenueCents"
     FROM customer_revenue cr
     JOIN customers c ON c.id = cr.customer_id
     ORDER BY cr.revenue_cents DESC
     LIMIT 5`,
  );

  log.info({ top5: rawResult.rows }, "raw SQL: top 5 customers by revenue (two chained CTEs)");

  const agree = drizzleTop5.every(
    (row, i) =>
      row.customerName === rawResult.rows[i]?.customerName &&
      String(row.revenueCents) === String(rawResult.rows[i]?.revenueCents),
  );
  log.info({ agree }, "Drizzle and raw SQL CTE results agree row-by-row");

  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ error }, "ctes demo failed");
  process.exit(1);
});
