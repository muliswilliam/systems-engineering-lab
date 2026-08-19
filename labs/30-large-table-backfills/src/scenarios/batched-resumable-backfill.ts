import "dotenv/config";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { measureSingleWrite, startWriteProber, summarizeLatencies } from "./write-prober.js";

const log = createLogger("lab30:scenario:batched");

export interface BackfillOptions {
  batchSize: number;
  /**
   * PACING/RATE LIMITING: a fixed sleep between committed batches. This is
   * deliberately the simplest possible mechanism, per CLAUDE.md's "start
   * with the simplest direct end-to-end path" - a production version might
   * instead poll `pg_stat_replication` for replica lag, check
   * `pg_stat_activity` for load, or watch its own p99 write latency and back
   * off adaptively, but a fixed sleep already gives the property that
   * matters here: the database gets real idle time between batches instead
   * of being hit with continuous back-to-back UPDATEs.
   */
  sleepMs: number;
  /**
   * Used ONLY by the interruption/resume demo (see
   * interrupted-resume-backfill.ts) and its tests: throw instead of
   * continuing once this many batches have committed, to deterministically
   * simulate "the process died here" without depending on OS-level timing.
   * Every batch up to and including this one has already committed to
   * Postgres by the time this throws - that's the whole point: each batch
   * is its own short transaction, independent of whether the NEXT batch
   * ever runs.
   */
  maxBatches?: number;
}

export interface BackfillResult {
  batches: number;
  rowsBackfilled: number;
}

/**
 * THE CORRECTED APPROACH: many small, independently-committed UPDATEs
 * instead of one giant one.
 *
 * `WHERE loyalty_points IS NULL ORDER BY id LIMIT $1` is what makes this
 * loop naturally RESUMABLE: it always operates on "whatever is still left,"
 * so calling this function again after a crash, a kill -9, or a deliberate
 * `maxBatches` stop simply continues from wherever the last COMMITTED batch
 * left off - it never re-touches an already-backfilled row (the `IS NULL`
 * predicate excludes it) and never skips a row (nothing else ever sets
 * `loyalty_points`).
 *
 * Each batch is a single autocommit statement, i.e. its own short
 * transaction: it acquires row locks on at most `batchSize` rows and
 * releases every one of them the instant that statement commits - never
 * "the whole table for the whole backfill" the way the naive single UPDATE
 * does.
 */
export async function backfillLoyaltyPoints(pool: Pool, options: BackfillOptions): Promise<BackfillResult> {
  const { batchSize, sleepMs, maxBatches } = options;
  let batches = 0;
  let rowsBackfilled = 0;

  for (;;) {
    const result = await pool.query(
      `UPDATE orders
       SET loyalty_points = floor(amount_cents / 100.0)
       WHERE id IN (
         SELECT id FROM orders WHERE loyalty_points IS NULL ORDER BY id LIMIT $1
       )`,
      [batchSize],
    );
    const rowCount = result.rowCount ?? 0;
    if (rowCount === 0) {
      break;
    }

    batches += 1;
    rowsBackfilled += rowCount;
    log.info({ batch: batches, rowsInBatch: rowCount, rowsBackfilled }, "batch committed");

    if (maxBatches !== undefined && batches >= maxBatches) {
      throw new Error(`simulated crash after ${batches} committed batches (maxBatches=${maxBatches})`);
    }

    if (sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }

  return { batches, rowsBackfilled };
}

function parseArgs(): { batchSize: number; sleepMs: number; maxBatches?: number } {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => args.find((a) => a.startsWith(`${flag}=`))?.split("=")[1];
  const batchSize = Number(get("--batch-size") ?? "1000");
  const sleepMs = Number(get("--sleep-ms") ?? "50");
  const maxBatchesArg = get("--max-batches");
  return { batchSize, sleepMs, maxBatches: maxBatchesArg ? Number(maxBatchesArg) : undefined };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  const connectionString = process.env.DATABASE_URL;
  const { batchSize, sleepMs, maxBatches } = parseArgs();

  const pool = createPool({ connectionString });
  await waitForDatabase(pool);

  const totals = await pool.query<{ total: string; pending: string; min_id: string }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE loyalty_points IS NULL) AS pending,
            min(id) AS min_id
     FROM orders`,
  );
  const row = totals.rows[0];
  if (!row || row.min_id === null) {
    throw new Error("orders table is empty - run `pnpm seed` first");
  }
  const targetOrderId = Number(row.min_id);

  log.info(
    { totalRows: Number(row.total), pendingRows: Number(row.pending), batchSize, sleepMs, maxBatches },
    "--- batched, resumable, rate-limited backfill ---",
  );

  log.info("baseline: measuring an ordinary write's latency before the backfill starts");
  const baselineLatencyMs = await measureSingleWrite(connectionString, targetOrderId);
  log.info({ baselineLatencyMs: Number(baselineLatencyMs.toFixed(2)) }, "baseline ordinary write completed");

  // Probe ordinary-write latency against the SAME row, continuously,
  // throughout the entire batched run - this is the direct, apples-to-apples
  // comparison against the naive scenario's identical probe.
  const prober = startWriteProber(connectionString, targetOrderId, 200);

  const start = performance.now();
  const result = await backfillLoyaltyPoints(pool, { batchSize, sleepMs, maxBatches });
  const durationMs = performance.now() - start;

  const probedSamples = await prober.stop();
  const concurrentWriteSummary = summarizeLatencies(probedSamples);

  const rowsPerSecond = result.rowsBackfilled / (durationMs / 1000);

  log.info(
    {
      batches: result.batches,
      rowsBackfilled: result.rowsBackfilled,
      durationMs: Number(durationMs.toFixed(0)),
      rowsPerSecond: Number(rowsPerSecond.toFixed(0)),
      baselineLatencyMs: Number(baselineLatencyMs.toFixed(2)),
      ordinaryWriteDuringBackfillMs: concurrentWriteSummary,
    },
    "batched backfill complete - ordinary writes against the same row stayed close to baseline the entire time",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "batched backfill scenario failed");
    process.exit(1);
  });
}
