import { createLogger } from "@labs/logging";
import { pool, waitForDatabase } from "../db/client.js";
import { explainAnalyzeJson } from "./explain-json.js";
import { PATTERN2_ORDERS_PLACED_AT } from "./index-definitions.js";
import { RECENT_ACTIVITY_QUERY } from "./queries.js";

const log = createLogger("lab33:scenario:pattern4-naive");

/**
 * Pattern 4 - "ORDER BY + LIMIT without a supporting index forces a full
 * sort." A "recent activity feed" query (no WHERE clause at all - this is
 * the whole-table case, deliberately different from Pattern 2's filtered
 * report) only needs the 20 most recent rows, but without an index on
 * `placed_at`, Postgres has no way to retrieve rows in that order other
 * than reading every row and sorting them (Postgres's Top-N heapsort
 * optimization still has to touch every row once - it only avoids
 * materializing the full sorted result).
 *
 * "Break it": drops the shared `idx_orders_placed_at` index (if present).
 */
async function main() {
  await waitForDatabase(pool);

  log.info({ index: PATTERN2_ORDERS_PLACED_AT.name }, "dropping placed_at index (if present)");
  await pool.query(`DROP INDEX IF EXISTS ${PATTERN2_ORDERS_PLACED_AT.name}`);

  const result = await explainAnalyzeJson(
    pool,
    log,
    "Pattern 4 naive: ORDER BY placed_at DESC LIMIT 20, no supporting index",
    RECENT_ACTIVITY_QUERY,
  );

  log.warn(
    {
      executionTimeMs: result.executionTimeMs,
      totalSharedHitBlocks: result.totalSharedHitBlocks,
      totalSharedReadBlocks: result.totalSharedReadBlocks,
      topLevelNodeTypes: result.nodes.map((n) => n["Node Type"]),
      hasSortNode: result.nodes.some((n) => n["Node Type"] === "Sort"),
    },
    "Pattern 4 naive: real measured cost of a full-table sort for a 20-row result",
  );

  log.info("run `pnpm scenario:pattern4-fixed` next to see the same query with the index present");

  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "pattern4-limit-naive scenario failed");
  process.exit(1);
});
