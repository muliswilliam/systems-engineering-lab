import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { metricEventsFlat } from "../db/schema.js";
import { PARTITIONED_TABLE, reconcileCanonicalPartitionLayout, resetListDemoTable } from "../db/partitions.js";
import { generateMetricEventsBatched, type MonthBatch } from "./generator.js";

const log = createLogger("lab35:seed");

type Size = "small" | "medium" | "large";

/**
 * Rows-per-month presets (SPEC.md 8.1: `pnpm seed --size=small|medium|large`).
 * Total rows per table = rowsPerMonth * 12.
 *
 * - small:  5,000/month  ->  60,000 rows/table. Fast (~seconds). Default,
 *   used by `pnpm test` and casual `pnpm dev` runs.
 * - medium: 50,000/month -> 600,000 rows/table.
 * - large:  100,000/month -> 1,200,000 rows/table. The size this lab's
 *   README numbers were captured against ("hundreds of thousands to ~1M+
 *   rows" per the lab brief). NOT the default - see README "Setup" for
 *   expected wall-clock time.
 */
const SIZE_PRESETS: Record<Size, number> = {
  small: 5_000,
  medium: 50_000,
  large: 100_000,
};

const INSERT_BATCH_SIZE = 5_000;
const PROGRESS_EVERY_BATCHES = 10;

function parseArgs(): { seed: number; rowsPerMonth: number; label: string } {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => args.find((a) => a.startsWith(`${flag}=`))?.split("=")[1];

  const seed = Number(get("--seed") ?? "42");

  const rowsArg = get("--rows");
  if (rowsArg) {
    const rows = Number(rowsArg);
    if (!Number.isFinite(rows) || rows <= 0) {
      throw new Error(`Invalid --rows value "${rowsArg}"`);
    }
    const rowsPerMonth = Math.max(1, Math.round(rows / 12));
    return { seed, rowsPerMonth, label: `--rows=${rows} (~${rowsPerMonth}/month)` };
  }

  const sizeArg = (get("--size") ?? "small") as Size;
  if (!(sizeArg in SIZE_PRESETS)) {
    throw new Error(`Unknown --size "${sizeArg}". Use small, medium, or large.`);
  }
  return { seed, rowsPerMonth: SIZE_PRESETS[sizeArg], label: `--size=${sizeArg}` };
}

async function insertPartitionedBatch(batch: MonthBatch["batch"]): Promise<void> {
  if (batch.length === 0) return;
  const values: unknown[] = [];
  const rows: string[] = [];
  batch.forEach((e, i) => {
    const base = i * 4;
    rows.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
    values.push(e.deviceId, e.metric, e.value, e.recordedAt);
  });
  await pool.query(
    `INSERT INTO ${PARTITIONED_TABLE} (device_id, metric, value, recorded_at) VALUES ${rows.join(", ")}`,
    values,
  );
}

async function main() {
  const { seed, rowsPerMonth, label } = parseArgs();
  const startedAt = Date.now();

  await waitForDatabase(pool);

  log.info({ label }, "reconciling metric_events_partitioned back to its canonical 12-month layout");
  const { dropped, created } = await reconcileCanonicalPartitionLayout(pool);
  if (dropped.length > 0 || created.length > 0) {
    log.info({ dropped, created }, "partition layout reconciled (scenario scripts may have left it non-canonical)");
  }
  await resetListDemoTable(pool);

  log.info({ seed, rowsPerMonth, label }, "clearing existing rows from both tables");
  // TRUNCATE on the partitioned PARENT cascades to every current partition
  // atomically - one statement clears all 12 children. RESTART IDENTITY on
  // both tables keeps ids deterministic across repeated reseeds (SPEC.md
  // 8.1: same seed -> same logical dataset every time).
  await pool.query("TRUNCATE TABLE metric_events_flat RESTART IDENTITY");
  await pool.query(`TRUNCATE TABLE ${PARTITIONED_TABLE} RESTART IDENTITY`);

  log.info({ rowsPerMonth, totalRowsPerTable: rowsPerMonth * 12 }, "generating and inserting into BOTH tables (streamed in batches)");

  let inserted = 0;
  let batchIndex = 0;

  for (const { month, batch } of generateMetricEventsBatched({ rowsPerMonth, seed, batchSize: INSERT_BATCH_SIZE })) {
    const flatRows = batch.map((e) => ({
      deviceId: e.deviceId,
      metric: e.metric,
      value: e.value,
      recordedAt: e.recordedAt,
    }));

    await Promise.all([db.insert(metricEventsFlat).values(flatRows), insertPartitionedBatch(batch)]);

    inserted += batch.length;
    batchIndex += 1;

    if (batchIndex % PROGRESS_EVERY_BATCHES === 0) {
      log.info({ month, batchIndex, insertedPerTable: inserted, elapsedMs: Date.now() - startedAt }, "seed progress");
    }
  }

  const elapsedMs = Date.now() - startedAt;
  log.info(
    {
      seed,
      insertedPerTable: inserted,
      insertedTotal: inserted * 2,
      elapsedMs,
      rowsPerSecondTotal: Math.round((inserted * 2) / (elapsedMs / 1000)),
    },
    "seed complete",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
