/**
 * Query text shared between a pattern's naive and fixed scenario scripts.
 * Deliberately kept in its own side-effect-free module (constants only, no
 * top-level `main()`) - importing a query constant directly from a sibling
 * scenario script would also execute that script's own `main()` as an
 * import side effect (and its `pool.end()` at the end), racing against the
 * importing script's own pool usage. This module has no side effects at
 * all, so it's safe to import from anywhere.
 */

export const PATTERN2_QUERY = `
  SELECT o.id, o.placed_at, c.full_name, count(ol.id) AS line_count, sum(ol.line_total_cents) AS revenue_cents
  FROM orders o
  JOIN customers c ON c.id = o.customer_id
  JOIN order_lines ol ON ol.order_id = o.id
  WHERE o.placed_at >= $1 AND o.placed_at < $2 AND o.status = 'paid'
  GROUP BY o.id, o.placed_at, c.full_name
  ORDER BY o.placed_at DESC
`;

/** The naive, non-sargable query: applies a function to the indexed column. */
export const NAIVE_MONTH_QUERY = `SELECT id, placed_at FROM orders WHERE date_trunc('month', placed_at AT TIME ZONE 'UTC') = $1`;

export const RECENT_ACTIVITY_QUERY = `SELECT id, placed_at, status FROM orders ORDER BY placed_at DESC LIMIT 20`;
