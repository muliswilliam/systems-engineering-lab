import { countDistinct, desc, eq, sum } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { customers, orderLines, orders } from "../db/schema.js";

const log = createLogger("lab03:demo:explain");

/**
 * Builds the "revenue + order count per customer" query (same shape as
 * aggregations.ts) with the Drizzle query builder, then runs both `EXPLAIN`
 * and `EXPLAIN ANALYZE` on the exact SQL it produces via `.toSQL()`.
 *
 * This lab deliberately has NO indexes - `customers.id`, `orders.customer_id`,
 * and `order_lines.order_id` are only indexed where a PRIMARY KEY or UNIQUE
 * constraint forces it (i.e. the `id` columns themselves, not the foreign
 * key columns used to join). That means every plan below should show
 * sequential scans on `orders` and `order_lines`, hash joins to combine
 * them, and a hash aggregate for the GROUP BY. See README "Observe" for how
 * to read this output, and Lab 04 for what changes once indexes exist.
 */
async function main() {
  await waitForDatabase(pool);

  const query = db
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

  const { sql: querySql, params } = query.toSQL();
  log.info({ sql: querySql, params }, "SQL produced by the Drizzle query builder");

  const explainResult = await pool.query(`EXPLAIN ${querySql}`, params);
  const explainLines = explainResult.rows.map((row) => row["QUERY PLAN"] as string);
  log.info({ plan: explainLines }, "EXPLAIN (estimated plan, not executed with real timings)");

  const explainAnalyzeResult = await pool.query(`EXPLAIN ANALYZE ${querySql}`, params);
  const explainAnalyzeLines = explainAnalyzeResult.rows.map((row) => row["QUERY PLAN"] as string);
  log.info(
    { plan: explainAnalyzeLines },
    "EXPLAIN ANALYZE (query was actually executed; timings and real row counts included)",
  );

  const hasSeqScan = explainLines.some((line) => line.includes("Seq Scan"));
  log.info(
    { hasSeqScan },
    hasSeqScan
      ? "confirmed: the plan includes a Seq Scan - there is no index to support this join/filter yet (expected; see Lab 04)"
      : "unexpected: no Seq Scan found in the plan",
  );

  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "explain demo failed");
  process.exit(1);
});
