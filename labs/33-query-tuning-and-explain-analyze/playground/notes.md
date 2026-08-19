# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Connect with `psql "$DATABASE_URL"` after `pnpm seed --seed=42 --size=large`
  and run `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT ...` by hand for a
  query shape of your own choosing against this lab's schema - compare the
  planner's `Plan Rows` against the real `Actual Rows` before assuming an
  index is the answer.
- Change Pattern 2's window size (`src/scenarios/sample-window.ts`,
  `pickMiddleWeekWindow`) from 7 days to 3, 14, and 30 days and rerun
  `pnpm scenario:pattern2-naive`/`pnpm scenario:pattern2-fixed` at each size -
  find the exact cardinality where the planner stops choosing a Nested Loop
  + `idx_order_lines_order_id` and switches back to a Hash Join with a full
  `order_lines` scan. This lab's own README numbers were captured at 7 days
  (~2,000 matching orders); at 30 days (~9,000 matching orders) the join
  strategy for `order_lines` never changes at all - see if you can find the
  crossover point.
- Run `ANALYZE orders;` then inspect `pg_stats` (`most_common_vals`,
  `most_common_freqs`) for `status` and compare it against
  `pg_stats_ext` for `orders_status_channel_stats` (Pattern 1b's extended
  statistics object) - `pg_stats_ext_exprs`/`pg_stats_ext` show the actual
  dependency/MCV data the planner uses for the correlated estimate.
- Try `pnpm scenario:pattern1-naive` a second time without reseeding first -
  it recategorizes ANOTHER batch of orders to `'cancelled'` on top of the
  first run's mutation (bounded by however many non-cancelled orders remain
  eligible). Watch the divergence ratio and the plan change as the real
  cancelled fraction keeps climbing.
- Drop `idx_orders_placed_at` and add a composite `(status, placed_at)`
  index instead - rerun Pattern 2's fixed query and compare the plan and
  buffer counts against the plain `idx_orders_placed_at` this lab ships
  with.
