-- Lab 04: performance indexes, added deliberately AFTER the base schema
-- migration (0000_graceful_stryfe.sql) already exists and has real data in
-- it - this is the "Fix it" half of this lab's before/after story.
--
-- This is a hand-written custom migration (`drizzle-kit generate --custom`)
-- rather than one produced by diffing src/db/schema.ts, because
-- drizzle-kit's schema-diffing support for partial indexes (WHERE),
-- covering indexes (INCLUDE), and expression indexes (lower(email)) is
-- inconsistent across versions. Per CLAUDE.md's "ORM plus SQL" principle -
-- use raw SQL where it is clearer or necessary, especially for anything
-- index/lock/plan related - raw SQL is the more honest tool here. Postgres
-- uses these indexes transparently regardless of whether the TypeScript
-- schema object in src/db/schema.ts "knows" about them; see that file's
-- header comment.
--
-- NOTE ON CONCURRENTLY: a production migration against a live, large table
-- should use `CREATE INDEX CONCURRENTLY` to avoid holding a lock that blocks
-- writes for the whole index build (a plain `CREATE INDEX` takes a SHARE
-- lock on the table - reads are still allowed, but INSERT/UPDATE/DELETE
-- block until the index finishes building). This lab uses plain
-- `CREATE INDEX` deliberately: it's simpler to reason about for a first
-- indexing lab, this is a local single-node database with no concurrent
-- production traffic to protect, and `CREATE INDEX CONCURRENTLY` cannot run
-- inside the transaction block Drizzle's migrator wraps each migration file
-- in. `CREATE INDEX CONCURRENTLY` and migration-safety under production load
-- is Lab 29's dedicated topic - do not copy plain `CREATE INDEX` onto a
-- production table without reading that lab first.
--
-- Every statement below uses IF NOT EXISTS so this migration is safe to
-- apply more than once (this lab's before/after scenario scripts also
-- re-run these exact statements directly - see
-- src/scenarios/index-definitions.ts).
--> statement-breakpoint

-- 1. Plain B-tree index: order_lines.order_id is a foreign key with no
--    supporting index. "Find all order_lines for a given order_id" is a
--    full sequential scan of order_lines without this - one of the most
--    common missing-index shapes in real schemas.
CREATE INDEX IF NOT EXISTS idx_order_lines_order_id ON order_lines (order_id);
--> statement-breakpoint

-- 2. Composite index: supports "recent orders for a given customer",
--    WHERE customer_id = ? ORDER BY placed_at DESC. The composite lets
--    Postgres use one index for both the equality filter AND the sort,
--    instead of a separate Sort step after finding the matching rows.
CREATE INDEX IF NOT EXISTS idx_orders_customer_id_placed_at ON orders (customer_id, placed_at);
--> statement-breakpoint

-- 3. Partial index: only ~12% of orders are 'pending' (see
--    packages/data-generators/src/commerce.ts STATUS_WEIGHTS). An ops-queue
--    query ("oldest pending orders") only ever cares about this minority of
--    rows, so indexing just those rows keeps the index small and cheap to
--    maintain relative to indexing all 4 statuses for every order.
CREATE INDEX IF NOT EXISTS idx_orders_pending_placed_at ON orders (placed_at) WHERE status = 'pending';
--> statement-breakpoint

-- 4. Covering index (index-only scan): a query that only needs product_id,
--    quantity, and unit_price_cents (e.g. "units sold and revenue for a
--    product") can be answered entirely from this index via an Index Only
--    Scan, without visiting the order_lines heap at all, once the
--    visibility map marks the relevant pages all-visible (VACUUM).
CREATE INDEX IF NOT EXISTS idx_order_lines_product_id_covering ON order_lines (product_id) INCLUDE (quantity, unit_price_cents);
--> statement-breakpoint

-- 5. Expression index: supports case-insensitive email lookup
--    (WHERE lower(email) = $1) without Postgres having to compute lower()
--    on every row's email at query time, which a plain index on `email`
--    cannot help with at all.
CREATE INDEX IF NOT EXISTS idx_customers_lower_email ON customers (lower(email));
--> statement-breakpoint

-- 6. Plain index used for the selectivity demonstration: 'paid' and
--    'shipped' together are ~80% of all orders, so the planner should
--    ignore this index and prefer a sequential scan for those values
--    (reading the whole table is cheaper than following that many index
--    entries back to the heap), while still being willing to use it for the
--    rarer 'cancelled' status (~8% of rows). See README "Observe" /
--    "index selectivity" and src/scenarios/after-indexing.ts.
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
