# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Seed the large dataset (`pnpm seed --size=large`, 1,000,000 rows) and rerun
  `pnpm scenario:naive` - watch the naive UPDATE's duration and the blocked
  write's latency both grow roughly linearly with row count, while
  `pnpm scenario:batched`'s concurrent-write latency barely changes at all.
- While `pnpm scenario:naive` is running, open a second `psql` session and
  run:
  ```sql
  SELECT pid, mode, granted, relation::regclass
  FROM pg_locks
  WHERE relation = 'orders'::regclass
  ORDER BY granted, pid;
  ```
  Watch the ordinary write's session show up with `granted = false` for the
  giant UPDATE's entire remaining duration.
- While `pnpm scenario:naive` is running, run:
  ```sql
  SELECT pid, now() - xact_start AS age, state, query
  FROM pg_stat_activity
  WHERE datname = current_database() AND pid <> pg_backend_pid()
  ORDER BY age DESC;
  ```
  and compare the naive UPDATE's single long-lived transaction against
  `scenario:batched`'s stream of many short-lived ones.
- Lower `batched-resumable-backfill.ts`'s default `--batch-size` and raise
  `--sleep-ms` and watch `rowsPerSecond` in the final log line drop
  accordingly - this is the batched approach's own throughput/safety
  tradeoff knob.
- Run `pnpm scenario:interrupted-resume` a few times in a row against the
  same dataset (without reseeding) - after the table is 100% backfilled, it
  should log that the killed child process itself found 0 pending rows to
  work on, and the "resume" call should also report 0 batches/0 rows.
- Try changing the naive scenario's target row from the lowest id to a row
  near the END of the id range and predict what happens to the observed
  block duration relative to when the concurrent write is issued.
