import { createLogger } from "@labs/logging";
import { pool, waitForDatabase } from "../db/client.js";
import { explainAnalyzeJson } from "./explain-json.js";
import { PATTERN2_ORDERS_PLACED_AT } from "./index-definitions.js";
import { RECENT_ACTIVITY_QUERY } from "./queries.js";

const log = createLogger("lab33:scenario:pattern4-fixed");

/**
 * Pattern 4 fixed - (re)creates the shared `idx_orders_placed_at` index,
 * then reruns the exact same recent-activity query.
 */
async function main() {
  await waitForDatabase(pool);

  const startedAt = Date.now();
  await pool.query(PATTERN2_ORDERS_PLACED_AT.createSql);
  log.info({ index: PATTERN2_ORDERS_PLACED_AT.name, elapsedMs: Date.now() - startedAt }, "created index");

  const result = await explainAnalyzeJson(
    pool,
    log,
    "Pattern 4 fixed: ORDER BY placed_at DESC LIMIT 20, index present",
    RECENT_ACTIVITY_QUERY,
  );

  log.info(
    {
      executionTimeMs: result.executionTimeMs,
      totalSharedHitBlocks: result.totalSharedHitBlocks,
      totalSharedReadBlocks: result.totalSharedReadBlocks,
      topLevelNodeTypes: result.nodes.map((n) => n["Node Type"]),
      hasSortNode: result.nodes.some((n) => n["Node Type"] === "Sort"),
    },
    "Pattern 4 fixed: real measured cost with the index present - no Sort node needed",
  );

  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "pattern4-limit-fixed scenario failed");
  process.exit(1);
});
