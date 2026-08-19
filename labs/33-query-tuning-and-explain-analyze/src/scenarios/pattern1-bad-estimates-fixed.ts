import { createLogger } from "@labs/logging";
import { pool, waitForDatabase } from "../db/client.js";
import { explainAnalyzeJson, rootRowEstimateVsActual } from "./explain-json.js";
import { CREATE_STATUS_CHANNEL_STATISTICS_SQL } from "./index-definitions.js";

const log = createLogger("lab33:scenario:pattern1-fixed");

/**
 * Pattern 1 fixed - run this right after `pnpm scenario:pattern1-naive`.
 *
 * Step A fixes Pattern 1a (stale statistics): a plain `ANALYZE orders`
 * recomputes the single-column statistics against the CURRENT data (which
 * pattern1-naive.ts already mutated), so the planner's row estimate for
 * `status = 'cancelled'` catches up to reality.
 *
 * Step B fixes Pattern 1b (correlated columns): `ANALYZE` alone CANNOT fix
 * this - single-column statistics have no way to represent "these two
 * columns are correlated," no matter how fresh they are. `CREATE STATISTICS
 * ... (dependencies, mcv) ON status, channel FROM orders` explicitly tells
 * the planner to model the joint distribution of the two columns together;
 * a subsequent `ANALYZE` is what actually populates it.
 */
async function main() {
  await waitForDatabase(pool);

  // --- Step A: fix Pattern 1a (stale stats) ---
  const startedAtAnalyze = Date.now();
  await pool.query("ANALYZE orders");
  const analyzeElapsedMs = Date.now() - startedAtAnalyze;

  const staleQuery = "SELECT id FROM orders WHERE status = 'cancelled'";
  const fixedStaleResult = await explainAnalyzeJson(
    pool,
    log,
    "Pattern 1a fixed: status='cancelled' (statistics refreshed via ANALYZE)",
    staleQuery,
  );
  const fixedStaleEstimateVsActual = rootRowEstimateVsActual(fixedStaleResult);

  log.info(
    {
      analyzeElapsedMs,
      plannerEstimatedRows: fixedStaleEstimateVsActual.estimated,
      actualRows: fixedStaleEstimateVsActual.actual,
      divergenceRatio: Number(
        (fixedStaleEstimateVsActual.actual / Math.max(1, fixedStaleEstimateVsActual.estimated)).toFixed(2),
      ),
      planUsedTopNodeType: fixedStaleResult.nodes[0]!["Node Type"],
    },
    "Pattern 1a fixed: ANALYZE alone brings the estimate back in line with reality",
  );

  // --- Step B: fix Pattern 1b (correlated columns) ---
  const startedAtStats = Date.now();
  await pool.query(CREATE_STATUS_CHANNEL_STATISTICS_SQL);
  await pool.query("ANALYZE orders");
  const statsElapsedMs = Date.now() - startedAtStats;

  const correlatedQuery = "SELECT id FROM orders WHERE status = 'cancelled' AND channel = 'phone'";
  const fixedCorrelatedResult = await explainAnalyzeJson(
    pool,
    log,
    "Pattern 1b fixed: status='cancelled' AND channel='phone' (extended statistics)",
    correlatedQuery,
  );
  const fixedCorrelatedEstimateVsActual = rootRowEstimateVsActual(fixedCorrelatedResult);

  log.info(
    {
      createStatisticsAndAnalyzeElapsedMs: statsElapsedMs,
      plannerEstimatedRows: fixedCorrelatedEstimateVsActual.estimated,
      actualRows: fixedCorrelatedEstimateVsActual.actual,
      divergenceRatio: Number(
        (
          fixedCorrelatedEstimateVsActual.actual / Math.max(1, fixedCorrelatedEstimateVsActual.estimated)
        ).toFixed(2),
      ),
    },
    "Pattern 1b fixed: extended statistics bring the AND-of-two-correlated-columns estimate back in line with reality",
  );

  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "pattern1-bad-estimates-fixed scenario failed");
  process.exit(1);
});
