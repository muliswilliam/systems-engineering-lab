import { createLogger } from "@labs/logging";
import { pool, waitForDatabase } from "../db/client.js";
import { explainAnalyzeJson } from "./explain-json.js";
import { PATTERN2_ORDERS_PLACED_AT, PATTERN2_ORDER_LINES_ORDER_ID } from "./index-definitions.js";
import { PATTERN2_QUERY } from "./queries.js";
import { pickMiddleWeekWindow } from "./sample-window.js";

const log = createLogger("lab33:scenario:pattern2-fixed");

/**
 * Pattern 2 fixed - (re)creates both target indexes, then reruns the exact
 * same report query from pattern2-join-naive.ts.
 */
async function main() {
  await waitForDatabase(pool);

  for (const index of [PATTERN2_ORDERS_PLACED_AT, PATTERN2_ORDER_LINES_ORDER_ID]) {
    const startedAt = Date.now();
    await pool.query(index.createSql);
    log.info({ name: index.name, elapsedMs: Date.now() - startedAt }, `created index: ${index.name}`);
  }

  const window = await pickMiddleWeekWindow(pool);
  log.info({ start: window.start, end: window.end }, "date window selected for this run");

  const result = await explainAnalyzeJson(
    pool,
    log,
    "Pattern 2 fixed: paid orders in a 7-day window, joined to customers + order_lines, both indexes present",
    PATTERN2_QUERY,
    [window.start, window.end],
  );

  log.info(
    {
      executionTimeMs: result.executionTimeMs,
      planningTimeMs: result.planningTimeMs,
      totalSharedHitBlocks: result.totalSharedHitBlocks,
      totalSharedReadBlocks: result.totalSharedReadBlocks,
      topLevelNodeTypes: result.nodes.map((n) => n["Node Type"]),
    },
    "Pattern 2 fixed: real measured cost with both indexes present",
  );

  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "pattern2-join-fixed scenario failed");
  process.exit(1);
});
