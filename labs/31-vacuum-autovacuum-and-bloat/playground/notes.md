# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Reseed with `--size=large` (150,000 rows) and run `pnpm scenario:bloat
  --rows=150000 --passes=30` - watch `sizeGrowthRatio` and `bufferRatio` both
  grow with the extra churn, then predict how much bigger `page_views_fresh`
  vs. `page_views`'s buffer counts would diverge at 1,000,000 rows.
- While `pnpm scenario:vacuum` is running, open a second `psql`/PGweb session
  and run:
  ```sql
  SELECT pid, mode, granted, relation::regclass
  FROM pg_locks
  WHERE relation = 'page_views'::regclass
  ORDER BY granted, pid;
  ```
  During the `VACUUM FULL` phase you should see several concurrent probe
  connections' lock requests sitting at `granted = false` at once; during the
  plain `VACUUM` phase, you should see none.
- Run:
  ```sql
  SELECT relname, n_live_tup, n_dead_tup, last_vacuum, last_autovacuum,
         vacuum_count, autovacuum_count
  FROM pg_stat_user_tables
  WHERE relname = 'page_views';
  ```
  before, during, and after `pnpm scenario:autovacuum` and watch
  `autovacuum_count` advance and `n_dead_tup` fall in real time.
- Try setting `autovacuum_vacuum_cost_delay` and `autovacuum_vacuum_cost_limit`
  (per-table storage parameters, same mechanism as this lab's
  `autovacuum_vacuum_scale_factor`/`autovacuum_vacuum_threshold` overrides) to
  throttle autovacuum's OWN I/O rate once it does run, and observe how much
  longer a single autovacuum pass takes against the same dead-tuple count.
- Compare `pg_relation_size('page_views')` against
  `pg_total_relation_size('page_views')` at each stage of `scenario:vacuum` -
  the gap between the two is index + TOAST overhead, which plain `VACUUM`
  also cannot shrink but `VACUUM FULL`'s index rebuild does.
- Look up `pg_repack` (not installed in this lab's minimal Postgres image)
  and read how it achieves a `VACUUM FULL`-equivalent size reduction while
  holding the strong lock only for a brief final swap, rather than the whole
  rewrite - contrast that design against this lab's own measured
  `vacuumFullBlockRatio`.
