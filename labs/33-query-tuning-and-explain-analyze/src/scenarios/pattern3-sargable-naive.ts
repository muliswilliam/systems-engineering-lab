import { createLogger } from "@labs/logging";
import { pool, waitForDatabase } from "../db/client.js";
import { explainAnalyzeJson } from "./explain-json.js";
import { PATTERN2_ORDERS_PLACED_AT, PATTERN3_ORDERS_MONTH_EXPR } from "./index-definitions.js";
import { NAIVE_MONTH_QUERY } from "./queries.js";
import { pickBusiestMonth } from "./sample-window.js";

const log = createLogger("lab33:scenario:pattern3-naive");

/**
 * Pattern 3 - "a function call in the WHERE clause defeats index usage."
 * `date_trunc('month', placed_at) = $1` is a genuinely common reporting
 * query shape ("all orders in March") - and it is NOT sargable: Postgres
 * would need `date_trunc('month', placed_at)` precomputed and indexed for
 * EVERY row to use an index for this comparison, which a plain index on the
 * raw `placed_at` column cannot provide, no matter how selective the
 * predicate actually is.
 *
 * "Break it": drops BOTH a plain `placed_at` index and this pattern's own
 * expression index (if present), so the naive query has no way to avoid a
 * full scan.
 */
async function main() {
  await waitForDatabase(pool);

  log.info(
    { indexes: [PATTERN2_ORDERS_PLACED_AT.name, PATTERN3_ORDERS_MONTH_EXPR.name] },
    "dropping placed_at-related indexes (if present) so this query genuinely has none to use",
  );
  await pool.query(`DROP INDEX IF EXISTS ${PATTERN2_ORDERS_PLACED_AT.name}`);
  await pool.query(`DROP INDEX IF EXISTS ${PATTERN3_ORDERS_MONTH_EXPR.name}`);

  const month = await pickBusiestMonth(pool);
  log.info({ monthStart: month.monthStartText, orderCount: month.orderCount }, "busiest month selected for this run");

  const result = await explainAnalyzeJson(
    pool,
    log,
    "Pattern 3 naive: date_trunc('month', placed_at) = ? (no supporting index of any kind)",
    NAIVE_MONTH_QUERY,
    [month.monthStartText],
  );

  log.warn(
    {
      executionTimeMs: result.executionTimeMs,
      totalSharedHitBlocks: result.totalSharedHitBlocks,
      totalSharedReadBlocks: result.totalSharedReadBlocks,
      topLevelNodeTypes: result.nodes.map((n) => n["Node Type"]),
      plannerEstimatedRows: result.nodes[0]!["Plan Rows"],
      actualRows: result.nodes[0]!["Actual Rows"],
    },
    "Pattern 3 naive: real measured cost of a non-sargable function-in-WHERE query",
  );

  log.info("run `pnpm scenario:pattern3-fixed` next to see both fix strategies");

  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "pattern3-sargable-naive scenario failed");
  process.exit(1);
});
