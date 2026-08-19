import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { pickSampleIds, type SampleIds } from "../../src/scenarios/sample-ids.js";
import { explainWithSettings, FORCE_INDEX_SETTINGS, FORCE_SEQ_SCAN_SETTINGS, queryWithSettings, sortRows } from "./plan-utils.js";
import { seedTestData } from "./seed-helper.js";

/**
 * This lab's core invariant, per CLAUDE.md/SPEC.md: an index must never
 * change what a query returns, only how Postgres gets there. Every test
 * below checks two things for one of this lab's 6 performance indexes:
 *
 * 1. the index is actually usable for its target query (forcing the
 *    planner toward it with `enable_seqscan = off` produces a plan that
 *    mentions the index / the expected scan type);
 * 2. forcing the index and forcing a sequential scan return the exact same
 *    row set.
 *
 * These are structural/correctness assertions, not timing assertions (see
 * SPEC.md section 11) - real timing comparisons live in
 * src/scenarios/before-indexing.ts and after-indexing.ts, run by hand
 * against the large seeded dataset (see README).
 */
let ids: SampleIds;

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await seedTestData();
  ids = await pickSampleIds(pool);
});

afterAll(async () => {
  await pool.end();
});

describe("idx_order_lines_order_id (plain B-tree)", () => {
  const queryText = "SELECT id, product_id, quantity FROM order_lines WHERE order_id = $1 ORDER BY id";

  it("is usable: a forced index plan mentions the index", async () => {
    const plan = await explainWithSettings(pool, FORCE_INDEX_SETTINGS, queryText, [ids.orderIdWithLines]);
    expect(plan).toContain("idx_order_lines_order_id");
  });

  it("does not change query correctness vs a forced sequential scan", async () => {
    const indexRows = await queryWithSettings(pool, FORCE_INDEX_SETTINGS, queryText, [ids.orderIdWithLines]);
    const seqRows = await queryWithSettings(pool, FORCE_SEQ_SCAN_SETTINGS, queryText, [ids.orderIdWithLines]);
    expect(indexRows.length).toBeGreaterThan(0);
    expect(sortRows(indexRows)).toEqual(sortRows(seqRows));
  });
});

describe("idx_orders_customer_id_placed_at (composite)", () => {
  const queryText = "SELECT id, placed_at, status FROM orders WHERE customer_id = $1 ORDER BY placed_at DESC";

  it("is usable: a forced index plan mentions the index", async () => {
    const plan = await explainWithSettings(pool, FORCE_INDEX_SETTINGS, queryText, [ids.customerIdWithOrders]);
    expect(plan).toContain("idx_orders_customer_id_placed_at");
  });

  it("does not change query correctness vs a forced sequential scan", async () => {
    const indexRows = await queryWithSettings(pool, FORCE_INDEX_SETTINGS, queryText, [ids.customerIdWithOrders]);
    const seqRows = await queryWithSettings(pool, FORCE_SEQ_SCAN_SETTINGS, queryText, [ids.customerIdWithOrders]);
    expect(indexRows.length).toBeGreaterThan(0);
    expect(sortRows(indexRows)).toEqual(sortRows(seqRows));
  });
});

describe("idx_orders_pending_placed_at (partial)", () => {
  const queryText = `SELECT id, placed_at FROM orders
     WHERE status = 'pending' AND placed_at > now() - interval '400 days'
     ORDER BY placed_at DESC`;

  // idx_orders_status (a plain, full index on status) also satisfies the
  // status = 'pending' condition in this query, and on a small test dataset
  // the cost difference between the two competing indexes is tiny enough
  // that the planner may pick either one - a real symptom of "everything is
  // cheap on a small table" (see seed-helper.ts / README). Dropping the
  // competing index for the duration of this one transaction (DDL is
  // transactional in Postgres - ROLLBACK undoes the DROP) isolates the
  // question this test actually asks: is idx_orders_pending_placed_at
  // itself usable and correct, independent of what else exists.
  const FORCE_INDEX_WITHOUT_COMPETING_INDEX = [...FORCE_INDEX_SETTINGS, "DROP INDEX idx_orders_status"];

  it("is usable: a forced index plan mentions the index", async () => {
    const plan = await explainWithSettings(pool, FORCE_INDEX_WITHOUT_COMPETING_INDEX, queryText);
    expect(plan).toContain("idx_orders_pending_placed_at");
  });

  it("does not change query correctness vs a forced sequential scan", async () => {
    const indexRows = await queryWithSettings(pool, FORCE_INDEX_SETTINGS, queryText);
    const seqRows = await queryWithSettings(pool, FORCE_SEQ_SCAN_SETTINGS, queryText);
    expect(sortRows(indexRows)).toEqual(sortRows(seqRows));
  });

  it("only ever matches rows with status = 'pending'", async () => {
    const rows = await queryWithSettings<{ id: number; placed_at: Date }>(pool, FORCE_INDEX_SETTINGS, queryText);
    const statusResult = await pool.query<{ status: string }>(
      "SELECT status FROM orders WHERE id = ANY($1)",
      [rows.map((r) => r.id)],
    );
    expect(statusResult.rows.every((r) => r.status === "pending")).toBe(true);
  });
});

describe("idx_order_lines_product_id_covering (covering / index-only scan)", () => {
  const queryText = "SELECT quantity, unit_price_cents FROM order_lines WHERE product_id = $1";

  it("is usable and answers the query as an Index Only Scan", async () => {
    const plan = await explainWithSettings(pool, FORCE_INDEX_SETTINGS, queryText, [ids.productIdWithLines]);
    expect(plan).toContain("idx_order_lines_product_id_covering");
    expect(plan).toContain("Index Only Scan");
  });

  it("does not change query correctness vs a forced sequential scan", async () => {
    const indexRows = await queryWithSettings(pool, FORCE_INDEX_SETTINGS, queryText, [ids.productIdWithLines]);
    const seqRows = await queryWithSettings(pool, FORCE_SEQ_SCAN_SETTINGS, queryText, [ids.productIdWithLines]);
    expect(indexRows.length).toBeGreaterThan(0);
    expect(sortRows(indexRows)).toEqual(sortRows(seqRows));
  });
});

describe("idx_customers_lower_email (expression)", () => {
  const queryText = "SELECT id, full_name FROM customers WHERE lower(email) = lower($1)";

  it("is usable: a forced index plan mentions the index", async () => {
    const plan = await explainWithSettings(pool, FORCE_INDEX_SETTINGS, queryText, [ids.sampleEmail]);
    expect(plan).toContain("idx_customers_lower_email");
  });

  it("does not change query correctness vs a forced sequential scan", async () => {
    const indexRows = await queryWithSettings(pool, FORCE_INDEX_SETTINGS, queryText, [ids.sampleEmail]);
    const seqRows = await queryWithSettings(pool, FORCE_SEQ_SCAN_SETTINGS, queryText, [ids.sampleEmail]);
    expect(indexRows.length).toBe(1);
    expect(sortRows(indexRows)).toEqual(sortRows(seqRows));
  });

  it("matches regardless of the casing used in the lookup value", async () => {
    const upper = await queryWithSettings(pool, FORCE_INDEX_SETTINGS, queryText, [ids.sampleEmail.toUpperCase()]);
    expect(upper.length).toBe(1);
  });
});

describe("idx_orders_status (selectivity demonstration)", () => {
  it("exists and is a plain btree index on orders.status", async () => {
    const result = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_orders_status'",
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]!.indexdef).toContain("orders");
    expect(result.rows[0]!.indexdef).toContain("status");
  });

  it("can be forced to answer an equality filter without changing the result set", async () => {
    const queryText = "SELECT id FROM orders WHERE status = 'cancelled' ORDER BY id";
    const indexRows = await queryWithSettings(pool, FORCE_INDEX_SETTINGS, queryText);
    const seqRows = await queryWithSettings(pool, FORCE_SEQ_SCAN_SETTINGS, queryText);
    expect(sortRows(indexRows)).toEqual(sortRows(seqRows));
  });
});
