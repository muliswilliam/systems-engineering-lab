import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { timeStatement } from "./partition-lib.js";
import { monthPartitionName, PARTITIONED_TABLE, PARTITIONED_YEAR } from "../db/partitions.js";

const log = createLogger("lab35:scenario:partition-maintenance");

// January is the oldest month in the seeded dataset - the natural
// "retention policy just kicked in, purge this month" target.
const TARGET_MONTH = 1;
const RANGE_FROM = "2025-01-01";
const RANGE_TO = "2025-02-01";

/**
 * Point 3: the real operational reason partitioning gets adopted, not just
 * query speed. Measures a REAL `ALTER TABLE ... DETACH PARTITION` + `DROP
 * TABLE` against the partitioned table, and a REAL, equivalent `DELETE FROM
 * ... WHERE recorded_at >= ... AND recorded_at < ...` against the flat
 * table covering the exact same rows - on the SAME machine, back to back.
 *
 * WARNING: this scenario permanently mutates both tables (it drops January
 * from the partitioned table and deletes January from the flat table). Run
 * `pnpm seed` again afterward to restore a clean baseline for the other
 * scenarios.
 */
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  const partitionName = monthPartitionName(PARTITIONED_YEAR, TARGET_MONTH);

  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM ${partitionName}`,
  );
  const rowCount = Number(countRows[0]!.count);

  log.info(
    { partitionName, rowCount, rangeFrom: RANGE_FROM, rangeTo: RANGE_TO },
    "--- Point 3: purging a full month of old data - DETACH+DROP (partitioned) vs. DELETE (flat), same row count, same machine ---",
  );

  // ------------------------------------------------------------------
  // Partitioned: DETACH PARTITION + DROP TABLE - a catalog operation.
  // Postgres just unlinks the partition from the parent's partition
  // descriptor and then removes the (now-standalone) table/file; it never
  // has to look at, lock, or vacuum a single row of January's data.
  // ------------------------------------------------------------------
  const detachMs = await timeStatement(pool, `ALTER TABLE ${PARTITIONED_TABLE} DETACH PARTITION ${partitionName}`);
  const dropMs = await timeStatement(pool, `DROP TABLE ${partitionName}`);
  const detachDropTotalMs = detachMs + dropMs;

  log.warn(
    {
      partitionName,
      rowsRemoved: rowCount,
      detachMs: Number(detachMs.toFixed(3)),
      dropMs: Number(dropMs.toFixed(3)),
      totalMs: Number(detachDropTotalMs.toFixed(3)),
    },
    "PARTITIONED: DETACH PARTITION + DROP TABLE - real measured duration, independent of row count",
  );

  // ------------------------------------------------------------------
  // Flat: the equivalent DELETE. Postgres must find every matching row
  // (via the recorded_at index), mark each one deleted (MVCC - the old
  // tuple versions become dead tuples for autovacuum to reclaim later),
  // and write a WAL record per affected row/page.
  // ------------------------------------------------------------------
  const deleteMs = await timeStatement(pool, `DELETE FROM metric_events_flat WHERE recorded_at >= $1 AND recorded_at < $2`, [
    RANGE_FROM,
    RANGE_TO,
  ]);

  log.warn(
    {
      rowsRemoved: rowCount,
      deleteMs: Number(deleteMs.toFixed(3)),
    },
    "FLAT: DELETE FROM ... WHERE recorded_at >= ... AND recorded_at < ... - real measured duration, scales with row count",
  );

  const speedup = deleteMs / Math.max(detachDropTotalMs, 0.001);
  log.warn(
    {
      rowCount,
      detachDropTotalMs: Number(detachDropTotalMs.toFixed(3)),
      deleteMs: Number(deleteMs.toFixed(3)),
      speedup: Number(speedup.toFixed(1)),
    },
    `SUMMARY: removing ${rowCount} rows via DETACH+DROP was ${speedup.toFixed(1)}x faster than the equivalent DELETE - DETACH+DROP cost is a near-constant catalog operation regardless of how many rows the partition holds, while DELETE cost is proportional to the row count. Re-run 'pnpm seed' to restore a clean dataset before running other scenarios.`,
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "partition maintenance scenario failed");
    process.exit(1);
  });
}
