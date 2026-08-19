import { desc, eq, sql, sum } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { customers, orderLines, orders } from "../db/schema.js";

const log = createLogger("lab03:demo:window-functions");

/**
 * Window functions in Drizzle's query builder are second-class citizens
 * compared to raw SQL: there is no `.over()` helper, so the `OVER (...)`
 * clause itself has to be written as a `sql` fragment even in the "Drizzle"
 * version below. This is exactly the case CLAUDE.md's "ORM plus SQL"
 * principle anticipates - the raw SQL version is the one to reach for first
 * when a query is genuinely window-function-shaped.
 *
 * 1. Running total of revenue per customer, ordered by when each order was
 *    placed (PARTITION BY customer, ORDER BY placed_at).
 * 2. RANK() of customers by total revenue - ties share a rank and the next
 *    rank is skipped (unlike ROW_NUMBER, which would break ties arbitrarily).
 */
async function main() {
  await waitForDatabase(pool);

  // --- 1. Running total per customer, ordered by order date ---

  const perOrder = db.$with("per_order").as(
    db
      .select({
        orderId: orders.id,
        customerId: orders.customerId,
        placedAt: orders.placedAt,
        orderRevenueCents: sum(orderLines.lineTotalCents).as("order_revenue_cents"),
      })
      .from(orders)
      .innerJoin(orderLines, eq(orderLines.orderId, orders.id))
      .groupBy(orders.id, orders.customerId, orders.placedAt),
  );

  const drizzleRunningTotal = await db
    .with(perOrder)
    .select({
      customerId: perOrder.customerId,
      orderId: perOrder.orderId,
      placedAt: perOrder.placedAt,
      orderRevenueCents: perOrder.orderRevenueCents,
      runningTotalCents: sql<string>`sum(${perOrder.orderRevenueCents}) over (
        partition by ${perOrder.customerId}
        order by ${perOrder.placedAt}, ${perOrder.orderId}
      )`.as("running_total_cents"),
    })
    .from(perOrder)
    .orderBy(perOrder.customerId, perOrder.placedAt)
    .limit(8);

  log.info(
    { sample: drizzleRunningTotal },
    "Drizzle (window OVER clause is raw sql`` inside the builder): running total per customer",
  );

  const rawRunningTotal = await pool.query(
    `SELECT
       o.customer_id AS "customerId",
       o.id          AS "orderId",
       o.placed_at   AS "placedAt",
       sum(ol.line_total_cents) AS "orderRevenueCents",
       sum(sum(ol.line_total_cents)) OVER (
         PARTITION BY o.customer_id
         ORDER BY o.placed_at, o.id
       ) AS "runningTotalCents"
     FROM orders o
     JOIN order_lines ol ON ol.order_id = o.id
     GROUP BY o.id, o.customer_id, o.placed_at
     ORDER BY o.customer_id, o.placed_at
     LIMIT 8`,
  );

  log.info({ sample: rawRunningTotal.rows }, "raw SQL: running total per customer");

  // --- 2. RANK customers by total revenue ---

  const customerRevenue = db.$with("customer_revenue").as(
    db
      .with(perOrder)
      .select({
        customerId: perOrder.customerId,
        revenueCents: sum(perOrder.orderRevenueCents).as("revenue_cents"),
      })
      .from(perOrder)
      .groupBy(perOrder.customerId),
  );

  const drizzleRanked = await db
    .with(perOrder, customerRevenue)
    .select({
      customerName: customers.fullName,
      revenueCents: customerRevenue.revenueCents,
      spendRank: sql<number>`rank() over (order by ${customerRevenue.revenueCents} desc)`,
    })
    .from(customerRevenue)
    .innerJoin(customers, eq(customers.id, customerRevenue.customerId))
    .orderBy(desc(customerRevenue.revenueCents))
    .limit(10);

  log.info({ top10: drizzleRanked }, "Drizzle: customers ranked by revenue (RANK())");

  const rawRanked = await pool.query(
    `WITH customer_revenue AS (
       SELECT o.customer_id, sum(ol.line_total_cents) AS revenue_cents
       FROM orders o
       JOIN order_lines ol ON ol.order_id = o.id
       GROUP BY o.customer_id
     )
     SELECT
       c.full_name AS "customerName",
       cr.revenue_cents AS "revenueCents",
       RANK() OVER (ORDER BY cr.revenue_cents DESC) AS "spendRank"
     FROM customer_revenue cr
     JOIN customers c ON c.id = cr.customer_id
     ORDER BY cr.revenue_cents DESC
     LIMIT 10`,
  );

  log.info({ top10: rawRanked.rows }, "raw SQL: customers ranked by revenue (RANK())");

  const agree = drizzleRanked.every(
    (row, i) => Number(row.spendRank) === Number(rawRanked.rows[i]?.spendRank),
  );
  log.info({ agree }, "Drizzle and raw SQL rank assignments agree row-by-row");

  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "window-functions demo failed");
  process.exit(1);
});
