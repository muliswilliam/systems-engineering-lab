import { createLogger } from "@labs/logging";
import { pool, waitForDatabase } from "../db/client.js";
import { explainAnalyzeJson } from "./explain-json.js";
import { PATTERN2_ORDERS_PLACED_AT, PATTERN2_ORDER_LINES_ORDER_ID } from "./index-definitions.js";
import { PATTERN2_QUERY } from "./queries.js";
import { pickMiddleWeekWindow } from "./sample-window.js";

const log = createLogger("lab33:scenario:pattern2-naive");

/**
 * Pattern 2 - "a multi-table JOIN with a missing index causes a sequential
 * scan where an index scan would be far cheaper." This is a genuinely
 * different query shape from Lab 04's own indexing lab: Lab 04's queries
 * were point lookups for ONE customer/order/product; this is an
 * operations-style report across ALL orders in a date window (`orders` has
 * no supporting index on `placed_at` and `order_lines` has no supporting
 * index on `order_id` - a foreign key, which Postgres never indexes
 * automatically).
 *
 * "Break it": drops both of this pattern's target indexes (if present) so
 * the "before" state is honest, then runs the report query with real
 * `EXPLAIN (ANALYZE, BUFFERS)`.
 */
async function main() {
  await waitForDatabase(pool);

  log.info(
    { indexes: [PATTERN2_ORDERS_PLACED_AT.name, PATTERN2_ORDER_LINES_ORDER_ID.name] },
    "dropping this pattern's target indexes (if present)",
  );
  await pool.query(`DROP INDEX IF EXISTS ${PATTERN2_ORDERS_PLACED_AT.name}`);
  await pool.query(`DROP INDEX IF EXISTS ${PATTERN2_ORDER_LINES_ORDER_ID.name}`);

  const window = await pickMiddleWeekWindow(pool);
  log.info({ start: window.start, end: window.end }, "date window selected for this run");

  const result = await explainAnalyzeJson(
    pool,
    log,
    "Pattern 2 naive: paid orders in a 7-day window, joined to customers + order_lines, no supporting indexes",
    PATTERN2_QUERY,
    [window.start, window.end],
  );

  const rowCountResult = await pool.query<{ count: string }>(
    `SELECT count(*) FROM orders WHERE placed_at >= $1 AND placed_at < $2 AND status = 'paid'`,
    [window.start, window.end],
  );

  log.warn(
    {
      matchingOrders: Number(rowCountResult.rows[0]!.count),
      executionTimeMs: result.executionTimeMs,
      planningTimeMs: result.planningTimeMs,
      totalSharedHitBlocks: result.totalSharedHitBlocks,
      totalSharedReadBlocks: result.totalSharedReadBlocks,
      topLevelNodeTypes: result.nodes.map((n) => n["Node Type"]),
    },
    "Pattern 2 naive: real measured cost with no supporting indexes",
  );

  log.info("run `pnpm scenario:pattern2-fixed` next to see the same query with both indexes present");

  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "pattern2-join-naive scenario failed");
  process.exit(1);
});
