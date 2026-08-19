import { createLogger } from "@labs/logging";
import { pool, waitForDatabase } from "../db/client.js";
import { explainAnalyze } from "./explain-utils.js";
import { INDEX_DEFINITIONS } from "./index-definitions.js";
import { pickSampleIds } from "./sample-ids.js";

const log = createLogger("lab04:scenario:before-indexing");

/**
 * "Break it" - drops every performance index this lab adds (if present) and
 * runs the same 6 demo queries `after-indexing.ts` runs, capturing real
 * EXPLAIN ANALYZE plans and timings with NO indexes beyond what PRIMARY
 * KEY/UNIQUE force. Expect sequential scans everywhere except the SKU
 * lookup (products.sku already has a UNIQUE constraint, which is itself a
 * B-tree index Postgres creates automatically - see query 6 below).
 *
 * This script explicitly DROPs the indexes (DROP INDEX IF EXISTS) rather
 * than assuming they were never created, so it produces an honest "before"
 * state even on a database where `pnpm db:migrate` already applied
 * 0001_add_performance_indexes.sql. Run `pnpm scenario:after-indexing`
 * afterward to recreate them and see the same queries plan differently.
 */
async function main() {
  await waitForDatabase(pool);

  log.info({ indexes: INDEX_DEFINITIONS.map((i) => i.name) }, "dropping performance indexes (if present)");
  for (const index of INDEX_DEFINITIONS) {
    await pool.query(`DROP INDEX IF EXISTS ${index.name}`);
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
      "Q6 product lookup by SKU (baseline - UNIQUE already indexes this, no change expected after migration)",
      "SELECT id, name FROM products WHERE sku = $1",
      [ids.sampleSku],
    ),
  );

  const seqScanCount = summaries.filter((s) => s.hasSeqScan).length;
  log.warn(
    { seqScanCount, totalQueries: summaries.length },
    seqScanCount >= 5
      ? "confirmed: most queries plan as sequential scans with no supporting index - run `pnpm scenario:after-indexing` next"
      : "unexpected: fewer sequential scans than expected - were the indexes actually dropped?",
  );

  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "before-indexing scenario failed");
  process.exit(1);
});
