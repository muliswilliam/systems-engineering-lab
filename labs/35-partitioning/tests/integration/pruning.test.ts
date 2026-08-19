import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { explain } from "../../src/scenarios/partition-lib.js";
import { reseed } from "./test-helpers.js";

const ROWS_PER_MONTH = 2_000;

function rangeQuery(table: string): string {
  return `SELECT count(*) FROM ${table} WHERE recorded_at >= $1 AND recorded_at < $2`;
}

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await reseed(pool, ROWS_PER_MONTH);
}, 180_000);

afterAll(async () => {
  await pool.end();
});

describe("partition pruning is real and structural, not just faster", () => {
  it("a query filtered entirely within one month touches EXACTLY 1 partition", async () => {
    const plan = await explain(pool, rangeQuery("metric_events_partitioned"), ["2025-06-09", "2025-06-16"]);
    const partitionsTouched = plan.relationsScanned.filter((r) => r.startsWith("metric_events_y"));
    expect(partitionsTouched).toEqual(["metric_events_y2025m06"]);
  });

  it("a query spanning a month boundary touches EXACTLY the 2 overlapping partitions", async () => {
    const plan = await explain(pool, rangeQuery("metric_events_partitioned"), ["2025-06-28", "2025-07-05"]);
    const partitionsTouched = plan.relationsScanned.filter((r) => r.startsWith("metric_events_y")).sort();
    expect(partitionsTouched).toEqual(["metric_events_y2025m06", "metric_events_y2025m07"]);
  });

  it("a query with NO filter on the partition key touches ALL 12 partitions - no pruning is possible", async () => {
    const plan = await explain(pool, `SELECT count(*) FROM metric_events_partitioned WHERE device_id = $1`, ["dev-0007"]);
    const partitionsTouched = plan.relationsScanned.filter((r) => r.startsWith("metric_events_y"));
    expect(partitionsTouched).toHaveLength(12);
  });

  it("the pruned partitioned query and the equivalent flat-table query return the SAME count - pruning changes cost, not correctness", async () => {
    const { rows: flatRows } = await pool.query<{ count: string }>(rangeQuery("metric_events_flat"), ["2025-06-09", "2025-06-16"]);
    const { rows: partRows } = await pool.query<{ count: string }>(rangeQuery("metric_events_partitioned"), ["2025-06-09", "2025-06-16"]);
    expect(partRows[0]!.count).toBe(flatRows[0]!.count);
    expect(Number(flatRows[0]!.count)).toBeGreaterThan(0);
  });
});
