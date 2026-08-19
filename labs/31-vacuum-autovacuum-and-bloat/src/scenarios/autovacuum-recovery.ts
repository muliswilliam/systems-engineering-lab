import "dotenv/config";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { seedPageViewsFlushed } from "../seed/seed.js";
import { getTableStats, formatBytes } from "./pg-stats.js";

const log = createLogger("lab31:scenario:autovacuum");

function parseArgs(): { rows: number } {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => args.find((a) => a.startsWith(`${flag}=`))?.split("=")[1];
  return { rows: Number(get("--rows") ?? "5000") };
}

/**
 * THE MECHANISM WORKING AS INTENDED: with autovacuum enabled and tuned to
 * react quickly, dead tuples get cleaned up automatically, with no operator
 * intervention - proven here by actually POLLING `pg_stat_user_tables` until
 * `autovacuum_count`/`last_autovacuum` genuinely advance, not by asserting
 * that autovacuum "must have" run.
 *
 * Per-table storage parameters (`autovacuum_vacuum_scale_factor = 0`,
 * `autovacuum_vacuum_threshold = 50`) make autovacuum trigger on THIS table
 * as soon as more than 50 dead tuples accumulate, rather than the instance
 * default (20% of the table's live rows plus 50) - a deliberate, LOCAL
 * override for the demo's benefit, not a claim that scale_factor=0 is a good
 * production default (see README "Production notes" for real tuning
 * guidance). `autovacuum_naptime=2s`, set instance-wide in
 * `docker-compose.yml`, controls how often the autovacuum LAUNCHER wakes up
 * to check every database at all - independent of the per-table thresholds
 * above, which control whether a given table qualifies for a worker once
 * the launcher does look.
 */
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  const connectionString = process.env.DATABASE_URL;
  const pool = createPool({ connectionString });
  await waitForDatabase(pool);

  const { rows } = parseArgs();

  log.info({ rows }, "--- autovacuum recovery: reseeding with autovacuum enabled and aggressively tuned ---");
  await seedPageViewsFlushed(connectionString, rows);
  await pool.query(
    `ALTER TABLE page_views SET (
       autovacuum_enabled = true,
       autovacuum_vacuum_scale_factor = 0.0,
       autovacuum_vacuum_threshold = 50
     )`,
  );

  const before = await getTableStats(pool, "page_views");
  log.info(
    {
      deadTuples: before.deadTuples,
      autovacuumCount: before.autovacuumCount,
      lastAutovacuum: before.lastAutovacuum,
    },
    "baseline before any churn - autovacuum has not needed to run yet",
  );

  log.info("performing one full-table UPDATE pass to create dead tuples far past the 50-row threshold ...");
  // A dedicated, freshly-opened-then-closed connection forces an immediate
  // stats flush on disconnect - see create-bloat.ts's doc comment for why
  // this matters for getting an accurate reading right away rather than
  // waiting out PostgreSQL's own per-backend stats-reporting throttle.
  const updateClient = new Client({ connectionString });
  await updateClient.connect();
  try {
    await updateClient.query("UPDATE page_views SET view_count = view_count + 1");
  } finally {
    await updateClient.end();
  }

  const afterUpdate = await getTableStats(pool, "page_views");
  log.warn(
    { deadTuples: afterUpdate.deadTuples, threshold: 50 },
    "dead tuples now well past this table's autovacuum_vacuum_threshold - autovacuum should pick this up on its next pass",
  );

  const pollIntervalMs = 500;
  const maxWaitMs = 30_000;
  const pollStart = performance.now();
  let triggered = false;
  let sawCount = before.autovacuumCount;

  while (performance.now() - pollStart < maxWaitMs) {
    const stats = await getTableStats(pool, "page_views");
    if (stats.autovacuumCount > before.autovacuumCount) {
      triggered = true;
      sawCount = stats.autovacuumCount;
      const elapsedMs = performance.now() - pollStart;
      log.warn(
        {
          elapsedMs: Number(elapsedMs.toFixed(0)),
          autovacuumCount: stats.autovacuumCount,
          lastAutovacuum: stats.lastAutovacuum,
          deadTuplesAfterAutovacuum: stats.deadTuples,
          relationSizeAfterAutovacuum: formatBytes(stats.relationSizeBytes),
        },
        "AUTOVACUUM RAN, CONFIRMED VIA pg_stat_user_tables: autovacuum_count advanced and dead tuples dropped, with zero operator intervention",
      );
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  if (!triggered) {
    log.error(
      { maxWaitMs, autovacuumCount: sawCount },
      "autovacuum did not run within the wait window - check docker-compose.yml's autovacuum_naptime and this table's storage parameters",
    );
    process.exitCode = 1;
  }

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "autovacuum-recovery scenario failed");
    process.exit(1);
  });
}
