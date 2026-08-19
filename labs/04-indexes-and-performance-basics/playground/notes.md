# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Connect with `psql "$DATABASE_URL"` after `pnpm seed --size=large` and run
  `EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM orders WHERE customer_id = 1;`
  by hand, then drop `idx_orders_customer_id_placed_at` and rerun it -
  compare the plan and the `Buffers:` line (shared hit/read) before and
  after.
- Run `SELECT indexname, pg_size_pretty(pg_relation_size(indexname::regclass)) FROM pg_indexes WHERE schemaname = 'public' ORDER BY 2 DESC;`
  after `pnpm scenario:after-indexing` - compare the size of
  `idx_orders_pending_placed_at` (partial, ~12% of rows) against
  `idx_orders_status` (full, 100% of rows) on the same table.
- Change `src/scenarios/write-amplification.ts`'s `DEFAULT_ORDER_COUNT` (or
  pass `--count=100000`) and see whether the relative slowdown from having
  6 indexes present grows, shrinks, or stays roughly proportional at higher
  write volume.
- Add a 7th index of your own (e.g. a composite on
  `order_lines(product_id, order_id)`) directly via `psql`, then write a
  query shaped to use it and confirm with `EXPLAIN` before adding it to
  `src/scenarios/index-definitions.ts` and the migration for real.
- Run `pnpm seed --rows=500000` and compare the customer/product counts it
  picks against `pnpm seed --size=medium` - both are estimates, not exact
  row-count guarantees (order counts are randomly distributed per
  customer), so compare `pnpm dev`'s reported `totalOrdersAndLines` against
  what you asked for.
- Try commenting out `VACUUM ANALYZE order_lines` in
  `after-indexing.ts` and rerun it against a **freshly reseeded** large
  dataset (autovacuum needs time to catch up on its own) - watch Q4's plan
  fall back to a plain `Index Scan` with nonzero `Heap Fetches` instead of
  `Index Only Scan`.
