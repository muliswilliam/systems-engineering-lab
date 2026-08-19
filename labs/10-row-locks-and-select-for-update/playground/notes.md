# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Open two `psql "$DATABASE_URL"` sessions side by side. In session 1:
  `BEGIN; SELECT balance_cents FROM accounts WHERE owner_name = 'Scenario Account - Select For Update' FOR UPDATE;`
  (do not commit). In session 2, run the same `SELECT ... FOR UPDATE` and
  watch it hang - then run `SELECT pg_locks.pid, pg_locks.mode, pg_locks.granted, pg_stat_activity.query FROM pg_locks JOIN pg_stat_activity ON pg_stat_activity.pid = pg_locks.pid WHERE pg_locks.relation = 'accounts'::regclass;`
  from a third session while session 2 is still hanging.
- In session 1, instead of `COMMIT`, run `ROLLBACK` - confirm session 2
  unblocks either way (a lock is released by either outcome, not just a
  successful commit).
- Try `SELECT ... FOR UPDATE NOWAIT` by hand in session 2 while session 1
  still holds the lock, and read the raw error `psql` prints - compare it to
  what `src/scenarios/nowait-and-lock-timeout.ts` reports programmatically.
- Try `SET lock_timeout = '2s';` in session 2 (no transaction needed for a
  simple demonstration) then `SELECT ... FOR UPDATE` against a row session 1
  is holding - time how long it actually takes to error out.
- Run `SHOW lock_timeout;` and `SHOW statement_timeout;` to see the
  session-wide defaults (both `0`, meaning "wait forever") before you set
  anything.
- Try changing `WITHDRAWAL_A_CENTS`/`WITHDRAWAL_B_CENTS` in
  `src/scenarios/lost-update-without-lock.ts` and
  `src/scenarios/select-for-update.ts` so the SECOND withdrawal in the
  FOR UPDATE scenario would overdraw the account, and confirm
  `outcomeB.applied` becomes `false` with `reason: "insufficient_funds"`
  instead of ever going negative.
- Add a THIRD concurrent transaction to `lost-update-without-lock.ts` (a
  third stale reader/writer) and confirm the lost-update problem gets worse,
  not better, with more concurrent writers - only the very last UPDATE to
  commit survives.
