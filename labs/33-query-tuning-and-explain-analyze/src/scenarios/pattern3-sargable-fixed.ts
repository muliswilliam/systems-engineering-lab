import { createLogger } from "@labs/logging";
import { pool, waitForDatabase } from "../db/client.js";
import { explainAnalyzeJson } from "./explain-json.js";
import { PATTERN2_ORDERS_PLACED_AT, PATTERN3_ORDERS_MONTH_EXPR } from "./index-definitions.js";
import { NAIVE_MONTH_QUERY } from "./queries.js";
import { asUtcInstant, pickBusiestMonth } from "./sample-window.js";

const log = createLogger("lab33:scenario:pattern3-fixed");

const REWRITTEN_SARGABLE_QUERY = `SELECT id, placed_at FROM orders WHERE placed_at >= $1 AND placed_at < $2`;

/**
 * Pattern 3 fixed - two independent fix strategies for the SAME underlying
 * problem, run back to back so their real costs can be compared directly:
 *
 * Fix A (expression index): index the exact expression the naive query
 * evaluates - `date_trunc('month', placed_at)`. The naive query text does
 * not change at all; only the index changes what plan is available for it.
 *
 * Fix B (sargable rewrite, PREFERRED per CLAUDE.md's "do not add indexes
 * blindly"): rewrite the query as an equivalent half-open range condition
 * on the RAW column (`placed_at >= start AND placed_at < end`), which a
 * plain B-tree index on `placed_at` can serve directly - the same index
 * Pattern 2 and Pattern 4 also need. No new, narrow, single-purpose index
 * required.
 */
async function main() {
  await waitForDatabase(pool);
  const month = await pickBusiestMonth(pool);
  log.info({ monthStart: month.monthStartText, orderCount: month.orderCount }, "busiest month selected for this run");

  // --- Fix A: expression index, naive query text unchanged ---
  await pool.query(PATTERN3_ORDERS_MONTH_EXPR.createSql);
  // CREATE INDEX does NOT retroactively run ANALYZE - without this, the
  // planner still has no per-expression statistics for
  // date_trunc('month', placed_at AT TIME ZONE 'UTC') and falls back to a
  // generic, badly-wrong default row estimate (a real thing this lab's own
  // development hit: the estimate stayed exactly as wrong as the naive
  // query's until this ANALYZE was added). The index alone already fixes
  // the ACCESS METHOD; ANALYZE is what also fixes the ESTIMATE.
  await pool.query("ANALYZE orders");
  log.info({ index: PATTERN3_ORDERS_MONTH_EXPR.name }, "created expression index (Fix A) and ran ANALYZE");

  const fixAResult = await explainAnalyzeJson(
    pool,
    log,
    "Pattern 3 Fix A: same date_trunc query, now with a matching expression index",
    NAIVE_MONTH_QUERY,
    [month.monthStartText],
  );

  // Fix A's expression index is single-purpose - drop it before measuring
  // Fix B so Fix B's numbers reflect ONLY the plain placed_at index, not
  // both indexes existing at once.
  await pool.query(`DROP INDEX IF EXISTS ${PATTERN3_ORDERS_MONTH_EXPR.name}`);

  // --- Fix B: sargable rewrite, reusing a plain, multi-purpose index ---
  await pool.query(PATTERN2_ORDERS_PLACED_AT.createSql);
  await pool.query("ANALYZE orders");
  log.info({ index: PATTERN2_ORDERS_PLACED_AT.name }, "created plain placed_at index (Fix B - also used by Pattern 2 and Pattern 4) and ran ANALYZE");

  const fixBResult = await explainAnalyzeJson(
    pool,
    log,
    "Pattern 3 Fix B: rewritten sargable range query, using the plain placed_at index",
    REWRITTEN_SARGABLE_QUERY,
    [asUtcInstant(month.monthStartText), asUtcInstant(month.monthEndText)],
  );

  log.info(
    {
      fixA: {
        index: PATTERN3_ORDERS_MONTH_EXPR.name,
        executionTimeMs: fixAResult.executionTimeMs,
        totalSharedHitBlocks: fixAResult.totalSharedHitBlocks,
        totalSharedReadBlocks: fixAResult.totalSharedReadBlocks,
        topLevelNodeTypes: fixAResult.nodes.map((n) => n["Node Type"]),
      },
      fixB: {
        index: PATTERN2_ORDERS_PLACED_AT.name,
        executionTimeMs: fixBResult.executionTimeMs,
        totalSharedHitBlocks: fixBResult.totalSharedHitBlocks,
        totalSharedReadBlocks: fixBResult.totalSharedReadBlocks,
        topLevelNodeTypes: fixBResult.nodes.map((n) => n["Node Type"]),
      },
    },
    "Pattern 3 fixed: Fix A (expression index) vs Fix B (rewrite + reused plain index) side by side",
  );

  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "pattern3-sargable-fixed scenario failed");
  process.exit(1);
});
