/**
 * Single source of truth for every performance fix this lab adds, mirrored
 * in `drizzle/0001_add_tuning_fixes.sql`. Each pattern's own naive/fixed
 * scenario scripts drop/create exactly the fix(es) that pattern is about,
 * the same "drop it yourself so the before-state is honest regardless of
 * migration state" discipline Lab 04 established.
 *
 * Only PATTERN2_ORDERS_PLACED_AT is deliberately shared: it is the fix for
 * Pattern 2 (join + date-range filter), the "prefer reuse" fix for Pattern 3
 * (sargable rewrite), AND the fix for Pattern 4 (ORDER BY + LIMIT) - one
 * well-chosen plain B-tree index on `orders.placed_at` earns its keep across
 * three real, different query shapes. See README "Architecture" for why
 * this is presented as a feature, not an accident.
 */
export interface IndexDefinition {
  name: string;
  table: string;
  purpose: string;
  createSql: string;
}

export const PATTERN1_ORDERS_STATUS: IndexDefinition = {
  name: "idx_orders_status",
  table: "orders",
  purpose:
    "plain B-tree on a low-cardinality column, used by Pattern 1a to show a stats-driven plan choice going stale",
  createSql: `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status)`,
};

export const PATTERN2_ORDERS_PLACED_AT: IndexDefinition = {
  name: "idx_orders_placed_at",
  table: "orders",
  purpose:
    "plain B-tree on placed_at - shared fix for Pattern 2 (join + date range), Pattern 3's rewrite fix, and Pattern 4 (ORDER BY + LIMIT)",
  createSql: `CREATE INDEX IF NOT EXISTS idx_orders_placed_at ON orders (placed_at)`,
};

export const PATTERN2_ORDER_LINES_ORDER_ID: IndexDefinition = {
  name: "idx_order_lines_order_id",
  table: "order_lines",
  purpose: "plain B-tree supporting the join back from order_lines to orders in Pattern 2",
  createSql: `CREATE INDEX IF NOT EXISTS idx_order_lines_order_id ON order_lines (order_id)`,
};

/**
 * `date_trunc('month', timestamptz)` is only STABLE (its result depends on
 * the session's `timezone` setting), and Postgres refuses to index a
 * non-IMMUTABLE expression ("functions in index expression must be marked
 * IMMUTABLE") - a real, easy-to-hit gotcha the first time you try to build
 * exactly this kind of expression index. `... AT TIME ZONE 'UTC'` first
 * converts the timestamptz to a plain `timestamp` (no zone) representing
 * that same instant's UTC wall-clock time; `date_trunc('month', timestamp)`
 * on a zone-less timestamp IS immutable, since there is no session state left
 * for the result to depend on. The naive query (pattern3-sargable-naive.ts)
 * must use the IDENTICAL expression for the planner to recognize a match.
 */
export const PATTERN3_ORDERS_MONTH_EXPR: IndexDefinition = {
  name: "idx_orders_month_expr",
  table: "orders",
  purpose:
    "expression index on date_trunc('month', placed_at AT TIME ZONE 'UTC') - Pattern 3's Fix A (index the exact expression the naive query evaluates)",
  createSql: `CREATE INDEX IF NOT EXISTS idx_orders_month_expr ON orders (date_trunc('month', placed_at AT TIME ZONE 'UTC'))`,
};

export const ALL_INDEXES: IndexDefinition[] = [
  PATTERN1_ORDERS_STATUS,
  PATTERN2_ORDERS_PLACED_AT,
  PATTERN2_ORDER_LINES_ORDER_ID,
  PATTERN3_ORDERS_MONTH_EXPR,
];

/**
 * The one fix in this lab that is NOT an index: extended statistics telling
 * the planner that `orders.status` and `orders.channel` are correlated
 * (Pattern 1b). It costs essentially nothing on every INSERT/UPDATE (no
 * structure to maintain per-write) - its only cost is a slightly longer
 * ANALYZE, since ANALYZE now also computes the cross-column statistics.
 */
export const STATUS_CHANNEL_STATISTICS_NAME = "orders_status_channel_stats";
export const CREATE_STATUS_CHANNEL_STATISTICS_SQL = `CREATE STATISTICS IF NOT EXISTS ${STATUS_CHANNEL_STATISTICS_NAME} (dependencies, mcv) ON status, channel FROM orders`;
export const DROP_STATUS_CHANNEL_STATISTICS_SQL = `DROP STATISTICS IF EXISTS ${STATUS_CHANNEL_STATISTICS_NAME}`;
