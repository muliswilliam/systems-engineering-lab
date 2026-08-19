import type { Pool } from "pg";
import { db } from "../../src/db/client.js";
import { metricEventsFlat } from "../../src/db/schema.js";
import { PARTITIONED_TABLE, reconcileCanonicalPartitionLayout } from "../../src/db/partitions.js";
import { generateMetricEventsBatched } from "../../src/seed/generator.js";

/**
 * Reconciles the partitioned table back to its canonical 12-month layout,
 * then truncates and reseeds BOTH tables with a known, deterministic row
 * count. Each test file calls this in its own `beforeAll` so it starts from
 * a known state regardless of what a previous file (run sequentially - see
 * vitest.config.ts) left behind, and regardless of any DETACH/ATTACH a
 * previous test performed.
 */
export async function reseed(pool: Pool, rowsPerMonth: number, seed = 42): Promise<void> {
  await reconcileCanonicalPartitionLayout(pool);
  await pool.query("TRUNCATE TABLE metric_events_flat RESTART IDENTITY");
  await pool.query(`TRUNCATE TABLE ${PARTITIONED_TABLE} RESTART IDENTITY`);

  for (const { batch } of generateMetricEventsBatched({ rowsPerMonth, seed, batchSize: 2_000 })) {
    const flatRows = batch.map((e) => ({ deviceId: e.deviceId, metric: e.metric, value: e.value, recordedAt: e.recordedAt }));
    await db.insert(metricEventsFlat).values(flatRows);

    const values: unknown[] = [];
    const rows: string[] = [];
    batch.forEach((e, i) => {
      const base = i * 4;
      rows.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      values.push(e.deviceId, e.metric, e.value, e.recordedAt);
    });
    await pool.query(`INSERT INTO ${PARTITIONED_TABLE} (device_id, metric, value, recorded_at) VALUES ${rows.join(", ")}`, values);
  }
}
