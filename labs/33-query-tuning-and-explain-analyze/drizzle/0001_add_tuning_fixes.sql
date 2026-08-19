-- Lab 33: query-tuning fixes, added deliberately AFTER the base schema
-- migration (0000_loving_eternals.sql) already exists - this is the
-- checked-in "fully fixed" end state each of the 4 patterns' own scenario
-- scripts drop and recreate to produce an honest before/after comparison
-- (see src/scenarios/index-definitions.ts, the single source of truth these
-- statements are mirrored from).
--
-- This is a hand-written custom migration (`drizzle-kit generate --custom`),
-- not one produced by diffing src/db/schema.ts, for the same reason Lab 04's
-- 0001 migration is hand-written: expression indexes and CREATE STATISTICS
-- have inconsistent-to-nonexistent drizzle-kit support. Per CLAUDE.md's "ORM
-- plus SQL" principle, raw SQL is the clearer and more honest tool here.
--
-- NOTE ON CONCURRENTLY: exactly Lab 04's note applies here too - a
-- production migration against a live, large table should use `CREATE INDEX
-- CONCURRENTLY` to avoid holding a SHARE lock that blocks writes for the
-- whole index build. This lab uses plain `CREATE INDEX` deliberately (local,
-- single-node, no concurrent production traffic to protect, and
-- `CREATE INDEX CONCURRENTLY` cannot run inside the transaction block
-- Drizzle's migrator wraps each migration in). See Lab 29 for migration
-- safety under real production load.
--
-- Every statement below uses IF NOT EXISTS so this migration is safe to
-- apply more than once - this lab's own before/after scenario scripts also
-- re-run these exact statements directly.
--> statement-breakpoint

-- Pattern 1a target: a plain B-tree on a low-cardinality column. This index
-- is genuinely useful when 'cancelled' is a rare ~8% minority (see
-- src/seed/seed.ts STATUS_WEIGHTS, reused from Lab 03/04's commerce
-- generator) - Pattern 1a's whole point is that this same, originally
-- correct index choice goes stale once the real distribution shifts and
-- nobody re-runs ANALYZE.
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
--> statement-breakpoint

-- Pattern 2 / Pattern 3 Fix B / Pattern 4 shared target: a plain B-tree on
-- placed_at. Three different real query shapes - a date-range join filter,
-- a rewritten sargable month-bucket filter, and a global ORDER BY + LIMIT -
-- all reuse this ONE index rather than each getting a narrow, single-purpose
-- index of their own. See README "Architecture".
CREATE INDEX IF NOT EXISTS idx_orders_placed_at ON orders (placed_at);
--> statement-breakpoint

-- Pattern 2 target: order_lines.order_id is a foreign key with no
-- supporting index (Postgres never creates one automatically for a foreign
-- key, only for PRIMARY KEY/UNIQUE) - required for an efficient join back
-- from orders to their line items.
CREATE INDEX IF NOT EXISTS idx_order_lines_order_id ON order_lines (order_id);
--> statement-breakpoint

-- Pattern 3 Fix A target: an expression index on
-- date_trunc('month', placed_at AT TIME ZONE 'UTC') - lets a query that
-- filters on that EXACT expression use an index, which a plain index on the
-- raw placed_at column cannot do. `AT TIME ZONE 'UTC'` first converts the
-- timestamptz to a zone-less timestamp; date_trunc('month', timestamptz)
-- alone is only STABLE (depends on the session's timezone setting) and
-- Postgres refuses to index a non-IMMUTABLE expression.
CREATE INDEX IF NOT EXISTS idx_orders_month_expr ON orders (date_trunc('month', placed_at AT TIME ZONE 'UTC'));
--> statement-breakpoint

-- Pattern 1b target: NOT an index. Extended statistics tell the planner
-- that orders.status and orders.channel are correlated (see seed.ts -
-- cancelled orders are disproportionately channel = 'phone' by
-- construction), which no amount of re-running plain ANALYZE on
-- single-column statistics can express. `dependencies` models "does knowing
-- status tell you something about channel," `mcv` stores actual frequent
-- (status, channel) COMBINATIONS directly - both improve the joint-filter
-- estimate for slightly different reasons, so this lab enables both.
CREATE STATISTICS IF NOT EXISTS orders_status_channel_stats (dependencies, mcv) ON status, channel FROM orders;
--> statement-breakpoint

-- CREATE STATISTICS only defines the object - it has no data until the next
-- ANALYZE (autovacuum's own ANALYZE will eventually pick it up too, but not
-- necessarily before a learner's first EXPLAIN after this migration runs).
ANALYZE orders;
