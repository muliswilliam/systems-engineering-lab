import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { customers, orderLines, orders } from "../db/schema.js";

const log = createLogger("lab03:scenario:naive");

export interface NaiveRevenueRow {
  customerId: number;
  customerName: string;
  /** Buggy - inflated by the order_lines join fan-out. See comment below. */
  reportedOrderCount: number;
  revenueCents: string;
}

/**
 * The bug: to compute revenue you must join orders -> order_lines (revenue
 * lives on the line, not the order). But once that join is in place, each
 * order row is duplicated once per line it has - an order with 3 lines
 * contributes 3 identical `orders.id` values to the joined result set.
 * `count(orders.id)` counts *rows in the joined result*, not distinct
 * orders, so it silently reports 3 orders where there is 1.
 *
 * `sum(order_lines.line_total_cents)` is unaffected by the same fan-out -
 * every line's own total still appears exactly once - which is exactly why
 * this bug is easy to ship: the revenue number is correct, so the order
 * count sitting right next to it on a dashboard looks trustworthy too.
 */
export async function runNaiveRevenueReport(limit = 10): Promise<NaiveRevenueRow[]> {
  return db
    .select({
      customerId: customers.id,
      customerName: customers.fullName,
      reportedOrderCount: sql<number>`count(${orders.id})::int`,
      revenueCents: sql<string>`sum(${orderLines.lineTotalCents})`,
    })
    .from(customers)
    .innerJoin(orders, eq(orders.customerId, customers.id))
    .innerJoin(orderLines, eq(orderLines.orderId, orders.id))
    .groupBy(customers.id, customers.fullName)
    .orderBy(sql`sum(${orderLines.lineTotalCents}) desc`)
    .limit(limit);
}

/** Ground truth: how many orders each customer actually has. */
export async function actualOrderCounts(customerIds: number[]): Promise<Map<number, number>> {
  if (customerIds.length === 0) return new Map();
  // customer_id is bigint - node-postgres returns bigint columns as strings
  // (to avoid silently losing precision beyond Number.MAX_SAFE_INTEGER), so
  // it is cast to ::int here and Number()-wrapped below to match the plain
  // JS numbers Drizzle hands back for this lab's bigint(mode: "number")
  // columns. Forgetting this cast is its own easy-to-miss bug: comparing a
  // string '786' against a number 786 as a Map key silently misses.
  const result = await pool.query<{ customer_id: number; actual_count: number }>(
    `SELECT customer_id::int AS customer_id, count(*)::int AS actual_count
     FROM orders
     WHERE customer_id = ANY($1)
     GROUP BY customer_id`,
    [customerIds],
  );
  return new Map(result.rows.map((r) => [Number(r.customer_id), Number(r.actual_count)]));
}

async function main(): Promise<void> {
  await waitForDatabase(pool);

  const rows = await runNaiveRevenueReport();
  const actual = await actualOrderCounts(rows.map((r) => r.customerId));

  let anyInflated = false;
  for (const row of rows) {
    const actualCount = actual.get(row.customerId) ?? 0;
    const inflated = row.reportedOrderCount !== actualCount;
    anyInflated = anyInflated || inflated;
    log.info(
      {
        customerName: row.customerName,
        reportedOrderCount: row.reportedOrderCount,
        actualOrderCount: actualCount,
        inflated,
        revenueCents: row.revenueCents,
      },
      "naive report row",
    );
  }

  log.warn(
    { anyInflated },
    anyInflated
      ? "confirmed: reportedOrderCount does not match actualOrderCount for at least one customer - the join fan-out bug is real. Run `pnpm scenario:fixed` for the corrected version."
      : "unexpected: no inflation observed - every customer in the top 10 happens to have exactly one line per order",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ error }, "naive scenario failed");
    process.exit(1);
  });
}
