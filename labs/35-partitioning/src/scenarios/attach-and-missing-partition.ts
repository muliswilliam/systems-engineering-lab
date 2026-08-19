import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { PARTITIONED_TABLE } from "../db/partitions.js";

const log = createLogger("lab35:scenario:attach-and-missing-partition");

const OUT_OF_RANGE_ROW = { deviceId: "dev-0001", metric: "temperature_c", value: 21.4, recordedAt: "2026-01-15T00:00:00Z" };

async function insertRow(pool: import("pg").Pool) {
  return pool.query(
    `INSERT INTO ${PARTITIONED_TABLE} (device_id, metric, value, recorded_at) VALUES ($1, $2, $3, $4) RETURNING id, recorded_at`,
    [OUT_OF_RANGE_ROW.deviceId, OUT_OF_RANGE_ROW.metric, OUT_OF_RANGE_ROW.value, OUT_OF_RANGE_ROW.recordedAt],
  );
}

/**
 * Point 4: partition maintenance must stay ahead of incoming data. This
 * table only has partitions for calendar year 2025 (drizzle/
 * 0001_create_partitioned_table.sql) - deliberately, and deliberately with
 * NO default partition - so a row dated in January 2026 has nowhere to go
 * until an operator (or a scheduled job) provisions that month ahead of
 * time.
 *
 * WARNING: on success this scenario permanently ATTACHes a real
 * `metric_events_y2026m01` partition. Run `pnpm seed` afterward to restore
 * the canonical 12-month layout for the other scenarios (see
 * src/db/partitions.ts's `reconcileCanonicalPartitionLayout`).
 */
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  log.info(
    { row: OUT_OF_RANGE_ROW },
    "--- Point 4: inserting a row with no matching partition, and no DEFAULT partition to catch it ---",
  );

  let captured: { code?: string; message?: string } | undefined;
  try {
    await insertRow(pool);
    log.error({}, "UNEXPECTED: insert succeeded - a partition for January 2026 already exists (re-run 'pnpm seed' to restore canonical layout, then retry)");
    await pool.end();
    return;
  } catch (error) {
    const pgError = error as { code?: string; message?: string };
    captured = { code: pgError.code, message: pgError.message };
  }

  log.warn(
    { postgresErrorCode: captured.code, message: captured.message },
    "REAL CAPTURED FAILURE: Postgres rejected the insert - no partition covers 2026-01, and there is no DEFAULT partition to fall back to",
  );

  // --- The fix: provision the missing partition, exactly the operation a
  // scheduled "create next month's partition" job would run ahead of time
  // in a healthy production setup, rather than reactively after a failed
  // insert like this demo does for teaching purposes. ---
  const newPartitionSql = `CREATE TABLE metric_events_y2026m01 PARTITION OF ${PARTITIONED_TABLE} FOR VALUES FROM ('2026-01-01') TO ('2026-02-01')`;
  await pool.query(newPartitionSql);
  log.info({ sql: newPartitionSql }, "FIX: provisioned the missing partition ahead of the data that needs it");

  const { rows } = await insertRow(pool);
  log.warn(
    { insertedId: rows[0]!.id, recordedAt: rows[0]!.recordedAt },
    "RETRY SUCCEEDED: the exact same insert that failed a moment ago now lands cleanly in metric_events_y2026m01",
  );

  // --- Demonstrate the HEALTHY pattern too: provisioning a FUTURE month
  // proactively, before any row needs it, is what a real scheduled job does
  // - not waiting for a failure like the reactive fix above. ---
  const proactiveSql = `CREATE TABLE metric_events_y2026m02 PARTITION OF ${PARTITIONED_TABLE} FOR VALUES FROM ('2026-02-01') TO ('2026-03-01')`;
  await pool.query(proactiveSql);
  log.info(
    { sql: proactiveSql },
    "OPERATIONAL DISCIPLINE: this is what a scheduled job should do BEFORE February 2026 ever produces a single row - partition maintenance has to run ahead of the data, not react to it",
  );

  log.warn({}, "Run 'pnpm seed' now to restore the canonical 12-month partition layout before running other scenarios.");

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "attach/missing-partition scenario failed");
    process.exit(1);
  });
}
