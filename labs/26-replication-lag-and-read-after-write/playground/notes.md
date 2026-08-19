# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Change `ARTIFICIAL_DELAY_MS` in each scenario script and re-run - does
  Strategy B's measured `waitedMs` track it closely? Does Strategy C's
  fallback decision still trigger correctly if you also change
  `LAG_THRESHOLD_MS` to be larger than the delay?
- In `strategy-a-sticky-primary.ts`, set `STICKY_WINDOW_MS` LARGER than
  `ARTIFICIAL_DELAY_MS` and re-run Part 2 - the "window expired but still
  stale" outcome should stop happening, because now the guess is generous
  enough.
- Connect with `psql "$PRIMARY_DATABASE_URL"` and `psql "$REPLICA_DATABASE_URL"`
  in two terminals. On the primary run
  `ALTER SYSTEM SET recovery_min_apply_delay = '2000ms'; SELECT pg_reload_conf();`
  against the REPLICA connection (not the primary!), then `UPDATE
  user_profiles SET display_name = 'manual-test' WHERE id = 1;` on the
  primary and watch how long it takes the replica's `SELECT` to show it.
- On the primary, run `SELECT * FROM pg_stat_replication;` while a scenario
  script with an induced delay is running, and watch `replay_lag` climb
  toward the configured delay in real time.
- Try a threshold-based Strategy C variant driven by `replay_lag_bytes`
  instead of `replay_lag_ms` (useful when `replay_lag`'s interval column is
  null but a byte gap is still measurable) and compare how the fallback
  decision differs.
