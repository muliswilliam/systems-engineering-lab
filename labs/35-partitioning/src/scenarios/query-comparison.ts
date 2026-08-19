import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { explain, bufferTotal } from "./partition-lib.js";

const log = createLogger("lab35:scenario:query-comparison");

const FLAT_INDEX = "metric_events_flat_recorded_at_idx";
const ITERATIONS = 5;

// A "last 7 days" window entirely INSIDE June 2025 - the typical dashboard
// query this lab is about ("give me last week's readings").
const WITHIN_MONTH_FROM = "2025-06-09";
const WITHIN_MONTH_TO = "2025-06-16";

// A window that straddles the June/July partition boundary, so the
// partitioned query MUST touch exactly 2 partitions instead of 1 - real
// evidence that pruning touches "the partitions that overlap the filter,"
// not always exactly one.
const BOUNDARY_FROM = "2025-06-28";
const BOUNDARY_TO = "2025-07-05";

function rangeQuery(table: string): string {
  return `SELECT count(*), avg(value) FROM ${table} WHERE recorded_at >= $1 AND recorded_at < $2`;
}

async function runMedian(pool: import("pg").Pool, sql: string, params: unknown[]) {
  let last: Awaited<ReturnType<typeof explain>> | undefined;
  const times: number[] = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    last = await explain(pool, sql, params);
    times.push(last.executionTimeMs);
  }
  times.sort((a, b) => a - b);
  const medianMs = times[Math.floor(times.length / 2)]!;
  return { medianMs, last: last! };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  log.info(
    { from: WITHIN_MONTH_FROM, to: WITHIN_MONTH_TO, iterations: ITERATIONS },
    "--- POINT 1/2: 'last week' query (filtered on the partition key) - naive seq scan vs. indexed flat table vs. partition pruning ---",
  );

  // 1. Naive: unpartitioned, no index at all.
  await pool.query(`DROP INDEX IF EXISTS ${FLAT_INDEX}`);
  const naive = await runMedian(pool, rangeQuery("metric_events_flat"), [WITHIN_MONTH_FROM, WITHIN_MONTH_TO]);
  log.warn(
    {
      medianExecutionMs: Number(naive.medianMs.toFixed(3)),
      topNodeType: naive.last.topNodeType,
      buffersTouched: bufferTotal(naive.last.buffers),
    },
    "NAIVE: metric_events_flat with NO index - full scan of the entire table regardless of the 7-day filter",
  );

  // 2. Fix #1 (not partitioning): a plain B-tree index on recorded_at.
  await pool.query(`CREATE INDEX IF NOT EXISTS ${FLAT_INDEX} ON metric_events_flat (recorded_at)`);
  const indexed = await runMedian(pool, rangeQuery("metric_events_flat"), [WITHIN_MONTH_FROM, WITHIN_MONTH_TO]);
  log.warn(
    {
      medianExecutionMs: Number(indexed.medianMs.toFixed(3)),
      topNodeType: indexed.last.topNodeType,
      buffersTouched: bufferTotal(indexed.last.buffers),
      speedupVsNaive: Number((naive.medianMs / Math.max(indexed.medianMs, 0.001)).toFixed(1)),
    },
    "INDEXED (still NOT partitioned): a plain B-tree index alone already fixes most of the problem - be honest that partitioning is not required for THIS win",
  );

  // 3. Partitioning: same query, filtered entirely within one partition.
  const pruned = await runMedian(pool, rangeQuery("metric_events_partitioned"), [WITHIN_MONTH_FROM, WITHIN_MONTH_TO]);
  log.warn(
    {
      medianExecutionMs: Number(pruned.medianMs.toFixed(3)),
      topNodeType: pruned.last.topNodeType,
      buffersTouched: bufferTotal(pruned.last.buffers),
      relationsScanned: pruned.last.relationsScanned,
      partitionsTouched: pruned.last.relationsScanned.filter((r) => r.startsWith("metric_events_y")).length,
      totalPartitionsThatExist: 12,
    },
    "PARTITIONED: EXPLAIN's own relationsScanned proves partition pruning - the planner touched only the ONE partition that can possibly contain matching rows, not all 12",
  );

  // 4. Boundary-spanning query: proves pruning touches "overlapping partitions", not always exactly 1.
  const boundary = await explain(pool, rangeQuery("metric_events_partitioned"), [BOUNDARY_FROM, BOUNDARY_TO]);
  log.warn(
    {
      from: BOUNDARY_FROM,
      to: BOUNDARY_TO,
      relationsScanned: boundary.relationsScanned,
      partitionsTouched: boundary.relationsScanned.filter((r) => r.startsWith("metric_events_y")).length,
    },
    "PARTITIONED, boundary-spanning window: a query crossing the June/July boundary correctly prunes to exactly the 2 overlapping partitions - not 1, not all 12",
  );

  log.warn(
    {
      summary: {
        naiveSeqScanMs: Number(naive.medianMs.toFixed(3)),
        indexedFlatMs: Number(indexed.medianMs.toFixed(3)),
        partitionedPrunedMs: Number(pruned.medianMs.toFixed(3)),
      },
    },
    "SUMMARY: indexing alone already closes most of the gap; partitioning's query-time win here is real but incremental on top of a good index - its bigger, non-query payoff is Point 3 (partition-maintenance) and Point 4 (operational discipline)",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "query comparison scenario failed");
    process.exit(1);
  });
}
