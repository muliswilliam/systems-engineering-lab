import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { explain, bufferTotal, median } from "./partition-lib.js";

const log = createLogger("lab35:scenario:no-benefit-query");

const ITERATIONS = 5;
const SAMPLE_DEVICE = "dev-0007";

/**
 * A query with NO filter on the partition key (recorded_at) - only on
 * device_id, a column partitioning was never organized around. This is the
 * lab's deliberately honest counter-example (task Point 2: "a query pattern
 * that actually benefits vs. one that does NOT benefit... be honest that
 * partitioning is not a universal speedup").
 */
function allTimeDeviceQuery(table: string): string {
  return `SELECT count(*), avg(value) FROM ${table} WHERE device_id = $1`;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  log.info(
    { device: SAMPLE_DEVICE, iterations: ITERATIONS },
    "--- Query with NO filter on the partition key ('all-time average for one device') - the honest counter-example ---",
  );

  const flatMs = await median(ITERATIONS, async () => (await explain(pool, allTimeDeviceQuery("metric_events_flat"), [SAMPLE_DEVICE])).executionTimeMs);
  const flatPlan = await explain(pool, allTimeDeviceQuery("metric_events_flat"), [SAMPLE_DEVICE]);
  log.warn(
    {
      medianExecutionMs: Number(flatMs.toFixed(3)),
      topNodeType: flatPlan.topNodeType,
      buffersTouched: bufferTotal(flatPlan.buffers),
    },
    "FLAT (indexed on recorded_at, which is USELESS for this filter): one relation, one scan",
  );

  const partitionedMs = await median(ITERATIONS, async () => (await explain(pool, allTimeDeviceQuery("metric_events_partitioned"), [SAMPLE_DEVICE])).executionTimeMs);
  const partitionedPlan = await explain(pool, allTimeDeviceQuery("metric_events_partitioned"), [SAMPLE_DEVICE]);
  const partitionsTouched = partitionedPlan.relationsScanned.filter((r) => r.startsWith("metric_events_y")).length;
  log.warn(
    {
      medianExecutionMs: Number(partitionedMs.toFixed(3)),
      topNodeType: partitionedPlan.topNodeType,
      buffersTouched: bufferTotal(partitionedPlan.buffers),
      relationsScanned: partitionedPlan.relationsScanned,
      partitionsTouched,
      totalPartitionsThatExist: 12,
    },
    "PARTITIONED: NO pruning is possible - the filter says nothing about recorded_at, so the planner must Append across EVERY partition and re-apply the device_id filter 12 times over",
  );

  log.warn(
    {
      flatMedianMs: Number(flatMs.toFixed(3)),
      partitionedMedianMs: Number(partitionedMs.toFixed(3)),
      flatBuffersTouched: bufferTotal(flatPlan.buffers),
      partitionedBuffersTouched: bufferTotal(partitionedPlan.buffers),
    },
    "HONEST CONCLUSION: for a query pattern that ignores the partition key entirely, partitioning provides ZERO structural pruning benefit - it MUST Append across all 12 partitions and touch MORE total buffers than the single-relation flat scan (each partition's index is walked separately). Wall-clock time can still land close to (or even under) the flat table's on a given run - Postgres genuinely can execute 12 small per-partition scans efficiently - but that is a coincidence of this machine/dataset, not a guarantee. The buffer count, not the wall clock, is the honest, deterministic signal that no pruning occurred.",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "no-benefit query scenario failed");
    process.exit(1);
  });
}
