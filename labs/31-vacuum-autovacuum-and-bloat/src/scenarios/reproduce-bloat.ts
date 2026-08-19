import "dotenv/config";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { reproduceBloat } from "./create-bloat.js";
import { getTableStats, formatBytes, explainSeqScanCount } from "./pg-stats.js";

const log = createLogger("lab31:scenario:bloat");

function parseArgs(): { rows: number; passes: number } {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => args.find((a) => a.startsWith(`${flag}=`))?.split("=")[1];
  return {
    rows: Number(get("--rows") ?? "50000"),
    passes: Number(get("--passes") ?? "15"),
  };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  const connectionString = process.env.DATABASE_URL;
  const pool = createPool({ connectionString });
  await waitForDatabase(pool);

  const { rows, passes } = parseArgs();
  log.info(
    { rows, passes },
    `--- bloat reproduction: ${passes} full-table UPDATE passes over ${rows} rows, autovacuum disabled ---`,
  );

  const result = await reproduceBloat(pool, connectionString, rows, passes);

  const sizeGrowthRatio = result.after.relationSizeBytes / result.before.relationSizeBytes;
  const totalTupleVersionsCreated = result.rows * result.passes;

  log.warn(
    {
      durationMs: Number(result.durationMs.toFixed(0)),
      before: {
        relationSize: formatBytes(result.before.relationSizeBytes),
        liveTuples: result.before.liveTuples,
        deadTuples: result.before.deadTuples,
      },
      after: {
        relationSize: formatBytes(result.after.relationSizeBytes),
        liveTuples: result.after.liveTuples,
        deadTuples: result.after.deadTuples,
      },
      sizeGrowthRatio: Number(sizeGrowthRatio.toFixed(2)),
      totalTupleVersionsCreated,
    },
    "REAL, MEASURED BLOAT: the table is now physically larger than its live row count requires - every dead tuple from every UPDATE pass is still on disk",
  );

  // --- Query performance consequence: compare a seq scan over the bloated
  // table against the SAME live row count with none of the dead-tuple
  // history, by cloning the CURRENT (live) rows into a freshly-written
  // table via CREATE TABLE ... AS SELECT.
  // A dedicated, freshly-opened-then-closed connection - see create-bloat.ts's
  // doc comment on why relying on a long-lived, already-used pool connection
  // can leave this new table's own pg_stat_user_tables row stale/missing
  // immediately after creation.
  const ctasClient = new Client({ connectionString });
  await ctasClient.connect();
  try {
    await ctasClient.query("DROP TABLE IF EXISTS page_views_fresh");
    await ctasClient.query(
      "CREATE TABLE page_views_fresh AS SELECT id, public_id, slug, view_count, updated_at FROM page_views",
    );
  } finally {
    await ctasClient.end();
  }
  const freshStats = await getTableStats(pool, "page_views_fresh");

  log.info(
    {
      bloatedLiveRows: result.after.liveTuples,
      freshLiveRows: freshStats.liveTuples,
      bloatedRelationSize: formatBytes(result.after.relationSizeBytes),
      freshRelationSize: formatBytes(freshStats.relationSizeBytes),
    },
    "created page_views_fresh: same LIVE row count, zero bloat, freshly written pages",
  );

  const bloatedPlan = await explainSeqScanCount(pool, "page_views");
  const freshPlan = await explainSeqScanCount(pool, "page_views_fresh");

  const bloatedTotalBlocks = bloatedPlan.sharedHitBlocks + bloatedPlan.sharedReadBlocks;
  const freshTotalBlocks = freshPlan.sharedHitBlocks + freshPlan.sharedReadBlocks;

  log.warn(
    {
      bloated: {
        executionTimeMs: Number(bloatedPlan.executionTimeMs.toFixed(3)),
        buffers: bloatedTotalBlocks,
        rowsReturned: bloatedPlan.actualRows,
      },
      fresh: {
        executionTimeMs: Number(freshPlan.executionTimeMs.toFixed(3)),
        buffers: freshTotalBlocks,
        rowsReturned: freshPlan.actualRows,
      },
      bufferRatio: Number((bloatedTotalBlocks / Math.max(freshTotalBlocks, 1)).toFixed(2)),
      timeRatio: Number((bloatedPlan.executionTimeMs / Math.max(freshPlan.executionTimeMs, 0.001)).toFixed(2)),
    },
    "WHY BLOAT MATTERS: a plain sequential scan for the SAME live row count reads measurably more pages, and takes measurably longer, on the bloated table",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "bloat scenario failed");
    process.exit(1);
  });
}
