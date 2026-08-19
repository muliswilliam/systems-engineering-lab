import { createLogger } from "@labs/logging";
import { pool, waitForDatabase } from "../db/client.js";
import { explainAnalyze } from "./explain-utils.js";
import { INDEX_DEFINITIONS } from "./index-definitions.js";
import { pickSampleIds } from "./sample-ids.js";

const log = createLogger("lab04:scenario:after-indexing");

/**
 * "Fix it" - (re)creates every performance index this lab adds and runs the
 * exact same 6 demo queries `before-indexing.ts` runs, capturing real
 * EXPLAIN ANALYZE plans and timings with the indexes present.
 *
 * This executes the CREATE INDEX statements directly (the same SQL that
 * lives in `drizzle/0001_add_performance_indexes.sql`) rather than going
 * through Drizzle's migrator. That matters because `before-indexing.ts`
 * dropped these indexes with raw DROP INDEX, which Drizzle's
 * migration-tracking table has no idea happened - `pnpm db:migrate` would
 * see migration 0001 already recorded as applied and do nothing. Executing
 * the CREATE INDEX (IF NOT EXISTS) statements directly here keeps this
 * before/after cycle self-contained and independent of migration-tracking
 * state. See README "Architecture" for why the index migration is plain
 * SQL rather than a Drizzle-generated one.
 */
async function main() {
  await waitForDatabase(pool);

  log.info({ indexes: INDEX_DEFINITIONS.map((i) => i.name) }, "creating performance indexes (if missing)");
  for (const index of INDEX_DEFINITIONS) {
    const startedAt = Date.now();
    await pool.query(index.createSql);
    log.info(
      { name: index.name, table: index.table, purpose: index.purpose, elapsedMs: Date.now() - startedAt },
      `created index: ${index.name}`,
    );
  }

  const ids = await pickSampleIds(pool);
  log.info({ ids }, "sample IDs selected for this run");

  const summaries = [];

  summaries.push(
    await explainAnalyze(
      pool,
      log,
      "Q1 recent orders for a customer (composite index target)",
      "SELECT id, placed_at, status FROM orders WHERE customer_id = $1 ORDER BY placed_at DESC LIMIT 10",
      [ids.customerIdWithOrders],
    ),
  );

  summaries.push(
    await explainAnalyze(
      pool,
      log,
      "Q2 order_lines for an order (plain B-tree target)",
      "SELECT id, product_id, quantity FROM order_lines WHERE order_id = $1",
      [ids.orderIdWithLines],
    ),
  );

  summaries.push(
    await explainAnalyze(
      pool,
      log,
      "Q3 pending orders ops queue (partial index target)",
      `SELECT id, placed_at FROM orders
       WHERE status = 'pending' AND placed_at > now() - interval '400 days'
       ORDER BY placed_at DESC LIMIT 50`,
    ),
  );

  // VACUUM ANALYZE order_lines before the covering-index query: an Index
  // Only Scan additionally requires the visibility map to mark matching
  // pages as all-visible, which normally happens via VACUUM (autovacuum
  // eventually does this on its own, but not necessarily by the moment this
  // script runs right after a bulk seed). Without this, Postgres may still
  // choose "Index Scan" instead of "Index Only Scan" even though the index
  // covers every column the query needs - a real, easy-to-miss gotcha.
  await pool.query("VACUUM ANALYZE order_lines");

  summaries.push(
    await explainAnalyze(
      pool,
      log,
      "Q4 quantity/price for a product (covering/index-only-scan target)",
      "SELECT quantity, unit_price_cents FROM order_lines WHERE product_id = $1",
      [ids.productIdWithLines],
    ),
  );

  summaries.push(
    await explainAnalyze(
      pool,
      log,
      "Q5 case-insensitive email lookup (expression index target)",
      "SELECT id, full_name FROM customers WHERE lower(email) = lower($1)",
      [ids.sampleEmail],
    ),
  );

  summaries.push(
    await explainAnalyze(
      pool,
      log,
      "Q6 product lookup by SKU (baseline - UNIQUE already indexed this pre- and post-migration)",
      "SELECT id, name FROM products WHERE sku = $1",
      [ids.sampleSku],
    ),
  );

  // Selectivity demo: idx_orders_status exists now, but the planner should
  // still IGNORE it for a common status value (paid, ~55% of rows - a
  // sequential scan reads the whole table anyway once selectivity is this
  // poor, so the extra index lookups would only add cost) while being
  // willing to use it for a rare status value (cancelled, ~8% of rows).
  await pool.query("ANALYZE orders");

  const paidCountResult = await pool.query<{ count: string }>(
    "SELECT count(*) FROM orders WHERE status = 'paid'",
  );
  const totalCountResult = await pool.query<{ count: string }>("SELECT count(*) FROM orders");
  const cancelledCountResult = await pool.query<{ count: string }>(
    "SELECT count(*) FROM orders WHERE status = 'cancelled'",
  );
  const paidCount = paidCountResult.rows[0]?.count ?? "0";
  const totalCount = totalCountResult.rows[0]?.count ?? "1";
  const cancelledCount = cancelledCountResult.rows[0]?.count ?? "0";

  log.info(
    {
      paidFraction: Number(paidCount) / Number(totalCount),
      cancelledFraction: Number(cancelledCount) / Number(totalCount),
    },
    "actual status selectivity in this dataset",
  );

  const paidSummary = await explainAnalyze(
    pool,
    log,
    "Q7a selectivity: status = 'paid' (common value, ~55% of rows - expect the planner to ignore idx_orders_status)",
    "SELECT id FROM orders WHERE status = 'paid'",
  );

  const cancelledSummary = await explainAnalyze(
    pool,
    log,
    "Q7b selectivity: status = 'cancelled' (rare value, ~8% of rows - expect the planner to use idx_orders_status)",
    "SELECT id FROM orders WHERE status = 'cancelled'",
  );

  log.info(
    {
      paidUsedIndex: paidSummary.hasIndexScan || paidSummary.hasBitmapScan,
      cancelledUsedIndex: cancelledSummary.hasIndexScan || cancelledSummary.hasBitmapScan,
    },
    "selectivity comparison result",
  );

  const indexScanCount = summaries.filter((s) => s.hasIndexScan || s.hasIndexOnlyScan || s.hasBitmapScan).length;
  log.info(
    { indexScanCount, totalQueries: summaries.length },
    indexScanCount >= 4
      ? "confirmed: most queries now plan as index scans / index-only scans / bitmap scans"
      : "unexpected: fewer index-supported plans than expected - check that the indexes above were actually created",
  );

  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "after-indexing scenario failed");
  process.exit(1);
});
