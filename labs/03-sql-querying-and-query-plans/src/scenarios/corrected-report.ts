import { fileURLToPath } from "node:url";
import { count, desc, eq, sum } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { customers, orderLines, orders } from "../db/schema.js";
import { actualOrderCounts } from "./naive-report.js";

const log = createLogger("lab03:scenario:fixed");

export interface CorrectedRevenueRow {
  customerId: number;
  customerName: string;
  orderCount: number;
  revenueCents: string | null;
}

/**
 * The fix: pre-aggregate order_lines down to one row per order *before*
 * joining to customers, using a CTE. `order_totals` collapses the fan-out at
 * its source - by the time `orders` is joined to `customer_revenue`, every
 * order contributes exactly one row, so a plain `count(orders.id)` is
 * finally correct. This is the general technique: when a query needs a
 * value from a one-to-many child (order_lines) alongside a count of the
 * parent (orders), aggregate the child into a per-parent row first, then
 * join - never join first and count across the join.
 *
 * (A narrower fix - `count(DISTINCT orders.id)` instead of `count(orders.id)`
 * in the naive query - also produces the correct order count. It is worth
 * knowing, but it only patches this one symptom: the moment a second
 * one-to-many join is added (say, order refunds) `count(DISTINCT ...)`
 * still overcounts against *that* join, while pre-aggregating each branch
 * before joining does not. See README "Tradeoffs".)
 */
export async function runCorrectedRevenueReport(limit = 10): Promise<CorrectedRevenueRow[]> {
  const orderTotals = db.$with("order_totals").as(
    db
      .select({
        orderId: orderLines.orderId,
        orderRevenueCents: sum(orderLines.lineTotalCents).as("order_revenue_cents"),
      })
      .from(orderLines)
      .groupBy(orderLines.orderId),
  );

  const rows = await db
    .with(orderTotals)
    .select({
      customerId: customers.id,
      customerName: customers.fullName,
      // orders is now joined 1:1 to orderTotals (one row per order), so a
      // plain count(orders.id) is finally accurate - contrast with
      // naive-report.ts, where the same expression overcounts.
      orderCount: count(orders.id),
      revenueCents: sum(orderTotals.orderRevenueCents),
    })
    .from(customers)
    .innerJoin(orders, eq(orders.customerId, customers.id))
    .innerJoin(orderTotals, eq(orderTotals.orderId, orders.id))
    .groupBy(customers.id, customers.fullName)
    .orderBy(desc(sum(orderTotals.orderRevenueCents)))
    .limit(limit);

  return rows;
}

async function main(): Promise<void> {
  await waitForDatabase(pool);

  const result = await pool.query<{
    customer_id: number;
    customer_name: string;
    order_count: string;
    revenue_cents: string;
  }>(
    `WITH order_totals AS (
       SELECT order_id, sum(line_total_cents) AS order_revenue_cents
       FROM order_lines
       GROUP BY order_id
     )
     SELECT
       c.id::int AS customer_id,
       c.full_name AS customer_name,
       count(o.id) AS order_count,
       sum(ot.order_revenue_cents) AS revenue_cents
     FROM customers c
     JOIN orders o ON o.customer_id = c.id
     JOIN order_totals ot ON ot.order_id = o.id
     GROUP BY c.id, c.full_name
     ORDER BY sum(ot.order_revenue_cents) DESC
     LIMIT 10`,
  );

  const rows = result.rows.map((r) => ({
    customerId: Number(r.customer_id),
    customerName: r.customer_name,
    orderCount: Number(r.order_count),
    revenueCents: r.revenue_cents,
  }));

  const actual = await actualOrderCounts(rows.map((r) => r.customerId));

  let allMatch = true;
  for (const row of rows) {
    const actualCount = actual.get(row.customerId) ?? 0;
    const matches = row.orderCount === actualCount;
    allMatch = allMatch && matches;
    log.info(
      {
        customerName: row.customerName,
        orderCount: row.orderCount,
        actualOrderCount: actualCount,
        matches,
        revenueCents: row.revenueCents,
      },
      "corrected report row",
    );
  }

  log.info(
    { allMatch },
    allMatch
      ? "confirmed: orderCount matches actualOrderCount for every customer - pre-aggregating order_lines before joining eliminated the fan-out"
      : "unexpected: a mismatch remains after the fix",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ error }, "corrected scenario failed");
    process.exit(1);
  });
}
