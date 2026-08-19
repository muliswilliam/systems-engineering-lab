/**
 * Single source of truth for the 6 performance indexes this lab adds on top
 * of Lab 03's commerce schema. The exact same `createSql` strings are used
 * in three places:
 *
 * 1. `drizzle/0001_add_performance_indexes.sql` - the checked-in migration
 *    a fresh `pnpm db:migrate` applies.
 * 2. `before-indexing.ts` - drops these indexes (DROP INDEX IF EXISTS) so
 *    the "before" EXPLAIN ANALYZE numbers reflect a genuinely unindexed
 *    table, even on a database where the migration already ran.
 * 3. `after-indexing.ts` / `write-amplification.ts` - re-creates them
 *    directly (bypassing Drizzle's migration-tracking table, which would
 *    otherwise think 0001 was "already applied" and refuse to re-run it
 *    after before-indexing.ts drops them).
 *
 * All CREATE INDEX statements use `IF NOT EXISTS` and all DROP statements
 * use `IF EXISTS`, so this before/after cycle is idempotent and safe to
 * repeat as many times as you like.
 */
export interface IndexDefinition {
  name: string;
  table: string;
  /** One-line description of what this index is for - printed in scenario output. */
  purpose: string;
  createSql: string;
}

export const INDEX_DEFINITIONS: IndexDefinition[] = [
  {
    name: "idx_order_lines_order_id",
    table: "order_lines",
    purpose: "plain B-tree index supporting 'find all order_lines for a given order_id'",
    createSql: `CREATE INDEX IF NOT EXISTS idx_order_lines_order_id ON order_lines (order_id)`,
  },
  {
    name: "idx_orders_customer_id_placed_at",
    table: "orders",
    purpose:
      "composite index supporting 'recent orders for a given customer_id' (equality + sort in one index)",
    createSql: `CREATE INDEX IF NOT EXISTS idx_orders_customer_id_placed_at ON orders (customer_id, placed_at)`,
  },
  {
    name: "idx_orders_pending_placed_at",
    table: "orders",
    purpose:
      "partial index (WHERE status = 'pending') supporting an ops queue query over only the ~12% of orders that are pending",
    createSql: `CREATE INDEX IF NOT EXISTS idx_orders_pending_placed_at ON orders (placed_at) WHERE status = 'pending'`,
  },
  {
    name: "idx_order_lines_product_id_covering",
    table: "order_lines",
    purpose:
      "covering index (INCLUDE quantity, unit_price_cents) supporting an index-only scan for per-product quantity/revenue queries",
    createSql: `CREATE INDEX IF NOT EXISTS idx_order_lines_product_id_covering ON order_lines (product_id) INCLUDE (quantity, unit_price_cents)`,
  },
  {
    name: "idx_customers_lower_email",
    table: "customers",
    purpose: "expression index on lower(email) supporting case-insensitive email lookup",
    createSql: `CREATE INDEX IF NOT EXISTS idx_customers_lower_email ON customers (lower(email))`,
  },
  {
    name: "idx_orders_status",
    table: "orders",
    purpose:
      "plain index on a low-cardinality column, used to demonstrate the planner ignoring an index when selectivity is poor",
    createSql: `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status)`,
  },
];
