import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { timeStatement } from "../../src/scenarios/partition-lib.js";
import { PARTITIONED_TABLE, monthPartitionName, PARTITIONED_YEAR } from "../../src/db/partitions.js";
import { reseed } from "./test-helpers.js";

// Large enough that DELETE's O(row count) cost is a real, reliable signal
// against DETACH+DROP's near-constant catalog-operation cost - not so large
// that the test suite becomes slow. See README "Fix it" for the same
// comparison at this lab's full --size=large dataset.
const ROWS_PER_MONTH = 50_000;
const TARGET_MONTH = 1;

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await reseed(pool, ROWS_PER_MONTH);
}, 180_000);

afterAll(async () => {
  await pool.end();
});

describe("DETACH PARTITION + DROP TABLE vs. DELETE for purging a full month of old data", () => {
  it("DETACH+DROP is dramatically faster than the equivalent DELETE for the same row count", async () => {
    const partitionName = monthPartitionName(PARTITIONED_YEAR, TARGET_MONTH);

    const { rows: countRows } = await pool.query<{ count: string }>(`SELECT count(*) FROM ${partitionName}`);
    const rowCount = Number(countRows[0]!.count);
    expect(rowCount).toBe(ROWS_PER_MONTH);

    const detachMs = await timeStatement(pool, `ALTER TABLE ${PARTITIONED_TABLE} DETACH PARTITION ${partitionName}`);
    const dropMs = await timeStatement(pool, `DROP TABLE ${partitionName}`);
    const detachDropTotalMs = detachMs + dropMs;

    const deleteMs = await timeStatement(pool, `DELETE FROM metric_events_flat WHERE recorded_at >= $1 AND recorded_at < $2`, [
      "2025-01-01",
      "2025-02-01",
    ]);

    // A generous factor (not a tight ratio) keeps this real, timing-based
    // assertion from being flaky on a loaded CI box, while still requiring
    // a genuinely large, structural difference - not noise.
    expect(deleteMs).toBeGreaterThan(detachDropTotalMs * 2);
  });

  it("both mechanisms leave the SAME final row count behind - equivalent semantic effect, different cost", async () => {
    const { rows: flatRows } = await pool.query<{ count: string }>("SELECT count(*) FROM metric_events_flat");
    const { rows: partRows } = await pool.query<{ count: string }>(`SELECT count(*) FROM ${PARTITIONED_TABLE}`);

    // Both tables started with ROWS_PER_MONTH * 12 rows; January's rows
    // (ROWS_PER_MONTH of them) were removed from both by the previous test.
    const expectedRemaining = ROWS_PER_MONTH * 11;
    expect(Number(flatRows[0]!.count)).toBe(expectedRemaining);
    expect(Number(partRows[0]!.count)).toBe(expectedRemaining);
  });

  it("January no longer exists as a partition of the partitioned table", async () => {
    const { rows } = await pool.query<{ relname: string }>(
      `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = $1`,
      [PARTITIONED_TABLE],
    );
    const names = rows.map((r) => r.relname);
    expect(names).not.toContain(monthPartitionName(PARTITIONED_YEAR, TARGET_MONTH));
    expect(names).toHaveLength(11);
  });
});
