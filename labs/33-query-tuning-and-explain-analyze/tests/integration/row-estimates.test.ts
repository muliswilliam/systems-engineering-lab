import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { explainAnalyzeJson, rootRowEstimateVsActual } from "../../src/scenarios/explain-json.js";
import { CREATE_STATUS_CHANNEL_STATISTICS_SQL, DROP_STATUS_CHANNEL_STATISTICS_SQL } from "../../src/scenarios/index-definitions.js";
import { seedTestData } from "./seed-helper.js";

const log = createLogger("lab33:test:row-estimates");

/**
 * This lab's second core invariant, the actual subject of Pattern 1: a row
 * ESTIMATE can be wrong for two structurally different reasons (stale
 * statistics vs. correlated columns), and the two fixes are NOT
 * interchangeable - ANALYZE cannot fix a correlation problem, and CREATE
 * STATISTICS is not needed to fix a plain staleness problem. These tests
 * assert the DIRECTION of improvement (estimate gets meaningfully closer to
 * reality after the correct fix), not exact row counts, since planner
 * estimates are themselves statistical and will vary slightly between runs
 * even on identical data (ANALYZE samples rows, it does not always read
 * every row).
 */
beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await seedTestData();
});

afterAll(async () => {
  await pool.end();
});

function divergence(estimated: number, actual: number): number {
  return actual / Math.max(1, estimated);
}

describe("Pattern 1a - stale statistics", () => {
  it("ANALYZE brings a stale row estimate back in line with a real, mutated distribution", async () => {
    await pool.query("ANALYZE orders");

    const beforeCount = await pool.query<{ count: string }>("SELECT count(*) FROM orders WHERE status = 'pending'");
    expect(Number(beforeCount.rows[0]!.count)).toBeGreaterThan(0);

    // Simulate a bulk recategorization: move every 'pending' order (a
    // real, existing status) to 'cancelled' WITHOUT re-analyzing - the
    // planner's next estimate for status = 'cancelled' is still based on
    // the pre-mutation distribution.
    await pool.query("UPDATE orders SET status = 'cancelled' WHERE status = 'pending'");

    const staleResult = await explainAnalyzeJson(
      pool,
      log,
      "test: stale estimate",
      "SELECT id FROM orders WHERE status = 'cancelled'",
    );
    const stale = rootRowEstimateVsActual(staleResult);
    const staleDivergence = divergence(stale.estimated, stale.actual);

    await pool.query("ANALYZE orders");

    const freshResult = await explainAnalyzeJson(
      pool,
      log,
      "test: fresh estimate",
      "SELECT id FROM orders WHERE status = 'cancelled'",
    );
    const fresh = rootRowEstimateVsActual(freshResult);
    const freshDivergence = divergence(fresh.estimated, fresh.actual);

    // The stale estimate must actually be wrong (otherwise this isn't
    // testing what it claims to), and ANALYZE must make it meaningfully
    // more accurate (closer to a divergence ratio of 1.0).
    expect(Math.abs(staleDivergence - 1)).toBeGreaterThan(0.3);
    expect(Math.abs(freshDivergence - 1)).toBeLessThan(Math.abs(staleDivergence - 1));
  });
});

describe("Pattern 1b - correlated columns", () => {
  beforeAll(async () => {
    await pool.query(DROP_STATUS_CHANNEL_STATISTICS_SQL);
    await pool.query("ANALYZE orders");
  });

  it("plain ANALYZE (single-column stats only) underestimates a correlated AND filter", async () => {
    const result = await explainAnalyzeJson(
      pool,
      log,
      "test: correlated, no extended stats",
      "SELECT id FROM orders WHERE status = 'cancelled' AND channel = 'phone'",
    );
    const { estimated, actual } = rootRowEstimateVsActual(result);
    // Independence-assumption estimate should undercount the real,
    // correlated population by a real, non-trivial margin.
    expect(actual).toBeGreaterThan(estimated);
  });

  it("CREATE STATISTICS + ANALYZE brings the correlated estimate meaningfully closer to reality", async () => {
    const beforeResult = await explainAnalyzeJson(
      pool,
      log,
      "test: correlated, before extended stats",
      "SELECT id FROM orders WHERE status = 'cancelled' AND channel = 'phone'",
    );
    const before = rootRowEstimateVsActual(beforeResult);
    const beforeDivergence = divergence(before.estimated, before.actual);

    await pool.query(CREATE_STATUS_CHANNEL_STATISTICS_SQL);
    await pool.query("ANALYZE orders");

    const afterResult = await explainAnalyzeJson(
      pool,
      log,
      "test: correlated, after extended stats",
      "SELECT id FROM orders WHERE status = 'cancelled' AND channel = 'phone'",
    );
    const after = rootRowEstimateVsActual(afterResult);
    const afterDivergence = divergence(after.estimated, after.actual);

    expect(Math.abs(afterDivergence - 1)).toBeLessThan(Math.abs(beforeDivergence - 1));
  });
});
