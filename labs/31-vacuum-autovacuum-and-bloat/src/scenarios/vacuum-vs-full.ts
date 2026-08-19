import "dotenv/config";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { reproduceBloat } from "./create-bloat.js";
import { getTableStats, formatBytes } from "./pg-stats.js";
import { startConcurrentWriteProbers, summarizeLatencies } from "./write-prober.js";

const PROBE_CONCURRENCY = 15;
const PROBE_INTERVAL_MS = 10;

/**
 * Runs a statement (VACUUM/VACUUM FULL cannot run inside a multi-statement
 * transaction block) on a dedicated, freshly-opened-then-closed connection,
 * timing only the statement itself. Ending the connection immediately after
 * forces PostgreSQL to flush this backend's final `pg_stat_user_tables`
 * report right away - see `create-bloat.ts`'s doc comment for why relying on
 * a shared, already-used pool connection can leave readings stale.
 */
async function runTimedStatement(connectionString: string, sql: string): Promise<number> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const start = performance.now();
    await client.query(sql);
    return performance.now() - start;
  } finally {
    await client.end();
  }
}

const log = createLogger("lab31:scenario:vacuum");

function parseArgs(): { rows: number; passes: number } {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => args.find((a) => a.startsWith(`${flag}=`))?.split("=")[1];
  return {
    rows: Number(get("--rows") ?? "80000"),
    passes: Number(get("--passes") ?? "20"),
  };
}

/**
 * THE FIX, both forms, and the real tradeoff between them.
 *
 * Plain `VACUUM`:
 * - takes only a `ShareUpdateExclusiveLock` on the table - this conflicts
 *   with another concurrent VACUUM, but NOT with ordinary reads or writes.
 * - marks dead tuples' space as REUSABLE by future INSERTs/UPDATEs. It does
 *   NOT return that space to the operating system - `pg_relation_size` stays
 *   roughly the same before and after.
 *
 * `VACUUM FULL`:
 * - rewrites the ENTIRE table into a brand-new file containing only live
 *   tuples, then swaps it in and drops the old file - this DOES shrink
 *   `pg_relation_size`, often dramatically.
 * - to do that safely it needs an `ACCESS EXCLUSIVE` lock for the table's
 *   ENTIRE rewrite duration - the strongest lock Postgres has, conflicting
 *   with every other lock mode including a plain `SELECT`. Any concurrent
 *   write (or read) queues up behind it for the whole operation.
 */
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  const connectionString = process.env.DATABASE_URL;
  const pool = createPool({ connectionString });
  await waitForDatabase(pool);

  const { rows, passes } = parseArgs();
  log.info({ rows, passes }, "--- building bloat to fix ---");
  const bloat = await reproduceBloat(pool, connectionString, rows, passes);

  log.warn(
    {
      relationSize: formatBytes(bloat.after.relationSizeBytes),
      liveTuples: bloat.after.liveTuples,
      deadTuples: bloat.after.deadTuples,
    },
    "bloat created - now demonstrating the fix",
  );

  // --- Plain VACUUM: measure dead-tuple reclamation, size unchanged, and
  // (near) zero impact on a concurrent ordinary write. ---
  log.info("starting concurrent write probes, then issuing plain VACUUM ...");
  const plainProber = startConcurrentWriteProbers(connectionString, 1, PROBE_CONCURRENCY, PROBE_INTERVAL_MS);
  const plainVacuumDurationMs = await runTimedStatement(connectionString, "VACUUM page_views");
  const plainSamples = await plainProber.stop();
  const plainSummary = summarizeLatencies(plainSamples);

  const afterPlainVacuum = await getTableStats(pool, "page_views");

  log.warn(
    {
      plainVacuumDurationMs: Number(plainVacuumDurationMs.toFixed(2)),
      deadTuplesBefore: bloat.after.deadTuples,
      deadTuplesAfter: afterPlainVacuum.deadTuples,
      relationSizeBefore: formatBytes(bloat.after.relationSizeBytes),
      relationSizeAfter: formatBytes(afterPlainVacuum.relationSizeBytes),
      concurrentWriteLatencyDuringPlainVacuum: plainSummary,
    },
    "PLAIN VACUUM: dead tuples reclaimed (marked reusable), but the file did NOT shrink - and ordinary concurrent writes were barely affected",
  );

  // --- VACUUM FULL: measure the real ACCESS EXCLUSIVE blocking cost against
  // the SAME kind of concurrent write, then the real size shrink. ---
  log.info("starting concurrent write probes, then issuing VACUUM FULL ...");
  const fullProber = startConcurrentWriteProbers(connectionString, 1, PROBE_CONCURRENCY, PROBE_INTERVAL_MS);
  // Give the prober loops a brief head start so several attempts are already
  // in flight (or about to be) by the time VACUUM FULL requests its ACCESS
  // EXCLUSIVE lock - otherwise this script could win a trivial race against
  // its own first probe attempts.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const vacuumFullDurationMs = await runTimedStatement(connectionString, "VACUUM FULL page_views");
  const fullSamples = await fullProber.stop();
  const fullSummary = summarizeLatencies(fullSamples);

  const afterVacuumFull = await getTableStats(pool, "page_views");

  log.warn(
    {
      vacuumFullDurationMs: Number(vacuumFullDurationMs.toFixed(2)),
      relationSizeBeforeVacuumFull: formatBytes(afterPlainVacuum.relationSizeBytes),
      relationSizeAfterVacuumFull: formatBytes(afterVacuumFull.relationSizeBytes),
      shrinkRatio: Number((afterPlainVacuum.relationSizeBytes / Math.max(afterVacuumFull.relationSizeBytes, 1)).toFixed(2)),
      concurrentWriteLatencyDuringVacuumFull: fullSummary,
    },
    "VACUUM FULL: the file genuinely shrank - but at the cost of an ACCESS EXCLUSIVE lock that blocked ordinary writes for close to its entire duration",
  );

  log.warn(
    {
      plainVacuumDurationMs: Number(plainVacuumDurationMs.toFixed(2)),
      plainVacuumWorstBlockedMs: plainSummary.maxMs,
      vacuumFullDurationMs: Number(vacuumFullDurationMs.toFixed(2)),
      vacuumFullWorstBlockedMs: fullSummary.maxMs,
      vacuumFullBlockRatio: Number((fullSummary.maxMs / vacuumFullDurationMs).toFixed(3)),
    },
    "THE TRADEOFF: plain VACUUM's worst-case concurrent-write latency stayed close to baseline; VACUUM FULL's worst case tracked almost exactly its own full duration",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "vacuum-vs-full scenario failed");
    process.exit(1);
  });
}
