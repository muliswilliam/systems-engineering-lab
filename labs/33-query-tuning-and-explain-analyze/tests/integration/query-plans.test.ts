import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import {
  PATTERN1_ORDERS_STATUS,
  PATTERN2_ORDERS_PLACED_AT,
  PATTERN2_ORDER_LINES_ORDER_ID,
  PATTERN3_ORDERS_MONTH_EXPR,
} from "../../src/scenarios/index-definitions.js";
import { asUtcInstant, pickBusiestMonth } from "../../src/scenarios/sample-window.js";
import { explainWithSettings, FORCE_INDEX_SETTINGS, FORCE_SEQ_SCAN_SETTINGS, queryWithSettings, sortRows } from "./plan-utils.js";
import { seedTestData } from "./seed-helper.js";

/**
 * This lab's core correctness invariant, the same one Lab 04 asserts: an
 * index (or an extended-statistics-informed plan choice) must never change
 * what a query returns, only how Postgres gets there and how confident its
 * cost estimate is. Every describe block below checks two things for one of
 * this lab's 4 indexes:
 *
 * 1. the index is actually usable for its target query (forcing the
 *    planner toward it with `enable_seqscan = off` produces a plan that
 *    mentions the index);
 * 2. forcing the index and forcing a sequential scan return the exact same
 *    row set.
 *
 * These are structural/correctness assertions, not timing assertions - real
 * timing/row-estimate comparisons live in the scenario scripts under
 * src/scenarios/, run by hand against the large seeded dataset (see
 * README).
 */
beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await seedTestData();
});

afterAll(async () => {
  await pool.end();
});

describe("idx_orders_status (Pattern 1a target)", () => {
  beforeAll(async () => {
    await pool.query(PATTERN1_ORDERS_STATUS.createSql);
  });

  it("is usable: a forced index plan mentions the index", async () => {
    const plan = await explainWithSettings(pool, FORCE_INDEX_SETTINGS, "SELECT id FROM orders WHERE status = 'cancelled'");
    expect(plan).toContain(PATTERN1_ORDERS_STATUS.name);
  });

  it("does not change query correctness vs a forced sequential scan", async () => {
    const queryText = "SELECT id FROM orders WHERE status = 'cancelled' ORDER BY id";
    const indexRows = await queryWithSettings(pool, FORCE_INDEX_SETTINGS, queryText);
    const seqRows = await queryWithSettings(pool, FORCE_SEQ_SCAN_SETTINGS, queryText);
    expect(sortRows(indexRows)).toEqual(sortRows(seqRows));
  });
});

describe("idx_orders_placed_at (shared Pattern 2 / 3 / 4 target)", () => {
  beforeAll(async () => {
    await pool.query(PATTERN2_ORDERS_PLACED_AT.createSql);
  });

  it("is usable for a plain range filter", async () => {
    const plan = await explainWithSettings(
      pool,
      FORCE_INDEX_SETTINGS,
      "SELECT id FROM orders WHERE placed_at >= now() - interval '400 days'",
    );
    expect(plan).toContain(PATTERN2_ORDERS_PLACED_AT.name);
  });

  it("is usable for ORDER BY ... LIMIT without a WHERE clause (Pattern 4)", async () => {
    const plan = await explainWithSettings(pool, FORCE_INDEX_SETTINGS, "SELECT id FROM orders ORDER BY placed_at DESC LIMIT 20");
    expect(plan).toContain(PATTERN2_ORDERS_PLACED_AT.name);
    // A correctly-used index for ORDER BY + LIMIT needs no separate Sort node.
    expect(plan).not.toContain("Sort");
  });

  it("does not change query correctness vs a forced sequential scan", async () => {
    const queryText = "SELECT id FROM orders WHERE placed_at >= now() - interval '400 days' ORDER BY id";
    const indexRows = await queryWithSettings(pool, FORCE_INDEX_SETTINGS, queryText);
    const seqRows = await queryWithSettings(pool, FORCE_SEQ_SCAN_SETTINGS, queryText);
    expect(sortRows(indexRows)).toEqual(sortRows(seqRows));
  });
});

describe("idx_order_lines_order_id (Pattern 2 join target)", () => {
  beforeAll(async () => {
    await pool.query(PATTERN2_ORDER_LINES_ORDER_ID.createSql);
  });

  it("is usable: a forced index plan mentions the index", async () => {
    const orderResult = await pool.query<{ order_id: string }>(
      "SELECT order_id FROM order_lines GROUP BY order_id HAVING count(*) >= 1 ORDER BY order_id LIMIT 1",
    );
    const orderId = orderResult.rows[0]!.order_id;
    const plan = await explainWithSettings(pool, FORCE_INDEX_SETTINGS, "SELECT id FROM order_lines WHERE order_id = $1", [orderId]);
    expect(plan).toContain(PATTERN2_ORDER_LINES_ORDER_ID.name);
  });

  it("does not change query correctness vs a forced sequential scan", async () => {
    const orderResult = await pool.query<{ order_id: string }>(
      "SELECT order_id FROM order_lines GROUP BY order_id HAVING count(*) >= 2 ORDER BY order_id LIMIT 1",
    );
    const orderId = orderResult.rows[0]!.order_id;
    const queryText = "SELECT id, product_id FROM order_lines WHERE order_id = $1 ORDER BY id";
    const indexRows = await queryWithSettings(pool, FORCE_INDEX_SETTINGS, queryText, [orderId]);
    const seqRows = await queryWithSettings(pool, FORCE_SEQ_SCAN_SETTINGS, queryText, [orderId]);
    expect(indexRows.length).toBeGreaterThan(0);
    expect(sortRows(indexRows)).toEqual(sortRows(seqRows));
  });
});

describe("idx_orders_month_expr (Pattern 3 Fix A - expression index)", () => {
  beforeAll(async () => {
    await pool.query(PATTERN3_ORDERS_MONTH_EXPR.createSql);
  });

  it("is usable for the exact expression it indexes", async () => {
    const month = await pickBusiestMonth(pool);
    const plan = await explainWithSettings(
      pool,
      FORCE_INDEX_SETTINGS,
      "SELECT id FROM orders WHERE date_trunc('month', placed_at AT TIME ZONE 'UTC') = $1",
      [month.monthStartText],
    );
    expect(plan).toContain(PATTERN3_ORDERS_MONTH_EXPR.name);
  });

  it("a plain index on the raw column cannot serve the same function-wrapped predicate", async () => {
    // idx_orders_placed_at (plain, on the raw column) also exists in this
    // suite by the time this test runs - proving the negative case matters:
    // even with a plain placed_at index available, forcing index usage for
    // date_trunc(...) = ? must still resolve to the EXPRESSION index, not
    // the plain one, because the plain index's sort key (raw placed_at) is
    // not the expression the query filters on.
    const month = await pickBusiestMonth(pool);
    const plan = await explainWithSettings(
      pool,
      FORCE_INDEX_SETTINGS,
      "SELECT id FROM orders WHERE date_trunc('month', placed_at AT TIME ZONE 'UTC') = $1",
      [month.monthStartText],
    );
    expect(plan).not.toContain(PATTERN2_ORDERS_PLACED_AT.name);
  });

  it("matches the equivalent rewritten sargable range query exactly", async () => {
    const month = await pickBusiestMonth(pool);

    const naiveRows = await queryWithSettings<{ id: number }>(
      pool,
      FORCE_INDEX_SETTINGS,
      "SELECT id FROM orders WHERE date_trunc('month', placed_at AT TIME ZONE 'UTC') = $1 ORDER BY id",
      [month.monthStartText],
    );
    const rewrittenRows = await queryWithSettings<{ id: number }>(
      pool,
      FORCE_INDEX_SETTINGS,
      "SELECT id FROM orders WHERE placed_at >= $1 AND placed_at < $2 ORDER BY id",
      [asUtcInstant(month.monthStartText), asUtcInstant(month.monthEndText)],
    );
    expect(sortRows(naiveRows)).toEqual(sortRows(rewrittenRows));
  });
});
