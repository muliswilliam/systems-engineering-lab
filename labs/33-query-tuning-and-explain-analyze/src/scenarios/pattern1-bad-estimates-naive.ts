import { createLogger } from "@labs/logging";
import { pool, waitForDatabase } from "../db/client.js";
import { explainAnalyzeJson, rootRowEstimateVsActual } from "./explain-json.js";
import { DROP_STATUS_CHANNEL_STATISTICS_SQL, PATTERN1_ORDERS_STATUS } from "./index-definitions.js";

const log = createLogger("lab33:scenario:pattern1-naive");

const DEFAULT_RECATEGORIZE_COUNT = 50_000;

function parseCount(): number {
  const arg = process.argv.slice(2).find((a) => a.startsWith("--count="));
  const count = arg ? Number(arg.split("=")[1]) : DEFAULT_RECATEGORIZE_COUNT;
  if (!Number.isFinite(count) || count <= 0) {
    throw new Error(`Invalid --count value "${arg}"`);
  }
  return count;
}

/**
 * Pattern 1 - "the planner's row ESTIMATE is badly wrong." Two distinct,
 * unrelated causes of the same symptom, run in this deliberate order so
 * each gets the cleanest possible measurement:
 *
 * Step A (Pattern 1b - correlated columns, measured FIRST, on pristine
 * seeded data): `orders.status` and `orders.channel` are correlated by
 * construction (see seed.ts - cancelled orders are disproportionately
 * `channel = 'phone'`). Postgres's default single-column statistics cannot
 * see that. Ensures fresh single-column stats exist (ANALYZE) and that NO
 * extended-statistics object exists yet, then runs the AND-of-two-columns
 * query and captures how far off the independence-assumption estimate is.
 *
 * Step B (Pattern 1a - stale statistics, mutates data): simulates a
 * backend policy change that reclassifies a large batch of previously
 * paid/pending/shipped orders as 'cancelled' - a real, plausible production
 * event (bulk write, not a rare edge case) - WITHOUT running ANALYZE
 * afterward. `idx_orders_status` was originally created (and is still
 * valid) when 'cancelled' was a rare ~8% minority; this step shows the
 * planner still reasoning from that now-stale 8% assumption after reality
 * has moved on.
 *
 * NOTE: Step B permanently mutates seeded data (an UPDATE, not reversible
 * except by `pnpm seed` again) - see README "Tradeoffs" for why, and why
 * that's true to the real incident this pattern models (an org actually
 * did do a bulk recategorization once; nobody re-ran ANALYZE afterward).
 */
async function main() {
  await waitForDatabase(pool);
  const recategorizeCount = parseCount();

  await pool.query(PATTERN1_ORDERS_STATUS.createSql);
  log.info({ index: PATTERN1_ORDERS_STATUS.name }, "ensured idx_orders_status exists (this pattern is about a stale ESTIMATE, not a missing index)");

  // --- Step A: Pattern 1b, correlated columns, pristine data ---
  await pool.query(DROP_STATUS_CHANNEL_STATISTICS_SQL);
  await pool.query("ANALYZE orders");
  log.info("dropped any extended statistics object and ran a fresh ANALYZE - single-column stats only, pristine data");

  const correlatedQuery =
    "SELECT id FROM orders WHERE status = 'cancelled' AND channel = 'phone'";
  const correlatedResult = await explainAnalyzeJson(
    pool,
    log,
    "Pattern 1b naive: status='cancelled' AND channel='phone' (single-column stats only)",
    correlatedQuery,
  );
  const correlatedEstimateVsActual = rootRowEstimateVsActual(correlatedResult);

  const distribution = await pool.query<{ status: string; channel: string; count: string }>(
    "SELECT status, channel, count(*) AS count FROM orders WHERE status = 'cancelled' GROUP BY status, channel ORDER BY channel",
  );
  log.warn(
    {
      estimatedRows: correlatedEstimateVsActual.estimated,
      actualRows: correlatedEstimateVsActual.actual,
      divergenceRatio: Number(
        (correlatedEstimateVsActual.actual / Math.max(1, correlatedEstimateVsActual.estimated)).toFixed(2),
      ),
      cancelledByChannel: distribution.rows,
    },
    "Pattern 1b: independence-assumption estimate vs real correlated data",
  );

  // --- Step B: Pattern 1a, stale statistics, mutates data ---
  const totalBefore = await pool.query<{ count: string }>("SELECT count(*) FROM orders");
  const cancelledBefore = await pool.query<{ count: string }>(
    "SELECT count(*) FROM orders WHERE status = 'cancelled'",
  );

  const updateResult = await pool.query(
    `UPDATE orders SET status = 'cancelled'
     WHERE id IN (SELECT id FROM orders WHERE status <> 'cancelled' ORDER BY id LIMIT $1)`,
    [recategorizeCount],
  );
  log.warn(
    { recategorizedCount: updateResult.rowCount, analyzeRunAfter: false },
    "Pattern 1a: bulk-recategorized a batch of orders to 'cancelled' WITHOUT running ANALYZE afterward",
  );

  const cancelledAfter = await pool.query<{ count: string }>(
    "SELECT count(*) FROM orders WHERE status = 'cancelled'",
  );
  const totalAfter = await pool.query<{ count: string }>("SELECT count(*) FROM orders");

  const staleQuery = "SELECT id FROM orders WHERE status = 'cancelled'";
  const staleResult = await explainAnalyzeJson(
    pool,
    log,
    "Pattern 1a naive: status='cancelled' (stale statistics, real distribution has shifted)",
    staleQuery,
  );
  const staleEstimateVsActual = rootRowEstimateVsActual(staleResult);

  log.warn(
    {
      cancelledCountBeforeUpdate: Number(cancelledBefore.rows[0]!.count),
      cancelledFractionBeforeUpdate: Number(cancelledBefore.rows[0]!.count) / Number(totalBefore.rows[0]!.count),
      cancelledCountAfterUpdate: Number(cancelledAfter.rows[0]!.count),
      cancelledFractionAfterUpdate: Number(cancelledAfter.rows[0]!.count) / Number(totalAfter.rows[0]!.count),
      plannerEstimatedRows: staleEstimateVsActual.estimated,
      actualRows: staleEstimateVsActual.actual,
      divergenceRatio: Number((staleEstimateVsActual.actual / Math.max(1, staleEstimateVsActual.estimated)).toFixed(2)),
      planUsedTopNodeType: staleResult.nodes[0]!["Node Type"],
    },
    "Pattern 1a: planner's row estimate is based on stale (pre-recategorization) statistics",
  );

  log.info("run `pnpm scenario:pattern1-fixed` next to see ANALYZE and CREATE STATISTICS correct both estimates");

  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "pattern1-bad-estimates-naive scenario failed");
  process.exit(1);
});
