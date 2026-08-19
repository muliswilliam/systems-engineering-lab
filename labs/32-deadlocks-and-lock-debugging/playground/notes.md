# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- While `pnpm scenario:deadlock` is running, open a second `psql`/PGweb
  session and run the same query `src/lib/diagnostics.ts` uses (adapted from
  `packages/db-utils/sql/show-blocked-queries.sql`) by hand - you likely
  won't win the race against `deadlock_timeout=300ms`, which is exactly why
  this lab's own diagnostic script polls `pg_stat_activity.wait_event_type`
  instead of guessing a delay.
- Add a THIRD account and a THIRD concurrent leg to `reproduce-deadlock.ts`
  (A locks 1 then wants 2, B locks 2 then wants 3, C locks 3 then wants 1) -
  a real 3-way cycle. Predict first: does `deadlock_timeout` still catch it?
  Does the diagnostic query still show the full cycle in one pass, or do you
  need to follow `blocked_by_pid` transitively?
- Change `docker-compose.yml`'s `deadlock_timeout` to `1s` (Postgres's real
  default) and rerun `pnpm scenario:deadlock` - the deadlock still resolves
  identically, just slower to detect. This proves the 300ms tuning in this
  lab is purely a demo-speed convenience, not part of the mechanism.
- Run `pnpm scenario:trials --trials=150` against a `--pairs=200`+ reseed and
  watch `deadlockCount` stay exactly equal to `trialCount` for
  `naive-lock-order` and exactly `0` for `consistent-lock-order` even at that
  scale - the invariant does not degrade with concurrency.
- Try locking the SAME row twice in a row inside one transaction (e.g.
  `SELECT ... FOR UPDATE` on the same id twice) - confirm this never
  deadlocks against itself, since Postgres tracks locks per transaction, not
  per statement.
