# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Open two `psql "$DATABASE_URL"` sessions side by side. In session 1: `BEGIN;
  SELECT xmin, ctid, value FROM counters WHERE label = 'page-views';`. In
  session 2: `UPDATE counters SET value = value + 1 WHERE label =
  'page-views';` (autocommit). Back in session 1, re-run the same `SELECT` -
  compare `xmin`/`ctid` before and after session 2's commit.
- Run `VACUUM counters;` after `pnpm scenario:xmin-xmax-ctid`, then try
  looking up the old tuple's `ctid` again from the script's log output - it
  should no longer be found once VACUUM has reclaimed it.
- Run `SELECT txid_current();` in one session and compare it against the
  `xmin`/`xmax` values you see logged - they're the same kind of value
  (a transaction ID), just truncated to 32 bits internally (`xmin`/`xmax`
  are `xid`, not `bigint`).
- Try `SELECT * FROM pg_stat_activity WHERE datname = current_database();`
  while `scenario:readers-dont-block-writers` is running (add a longer
  `READER_HOLD_MS` locally) and watch the two backends' `state` and
  `wait_event_type` columns during phase 2's blocking UPDATE.
