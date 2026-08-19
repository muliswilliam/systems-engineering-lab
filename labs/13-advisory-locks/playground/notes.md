# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Open two `psql "$DATABASE_URL"` sessions side by side. In session 1:
  `SELECT pg_advisory_lock(42);` (do not disconnect). In session 2:
  `SELECT pg_try_advisory_lock(42);` - confirm it returns `f`. Back in
  session 1: `SELECT pg_advisory_unlock(42);`, then rerun session 2's
  try-lock and confirm it now returns `t`.
- With session 1 still holding `pg_advisory_lock(42)`, run
  `SELECT locktype, mode, granted, pid FROM pg_locks WHERE locktype = 'advisory';`
  in a third session and see the lock's `classid`/`objid` encoding show up
  directly in `pg_locks` - advisory locks are real entries in the same lock
  table row locks use, just with `locktype = 'advisory'` instead of
  `'relation'` or `'tuple'`.
- Kill session 1's `psql` process (or just close the terminal) instead of
  running `pg_advisory_unlock` - confirm from session 2 that the lock frees
  itself once Postgres notices the connection is gone. Compare how long that
  takes to the 300ms `POST_DISCONNECT_SETTLE_MS` this lab's
  `connection-loss-releases-lock.ts` scenario waits before checking.
- Try `SELECT pg_advisory_xact_lock(42);` without a `BEGIN` first, then
  `SELECT pg_locks WHERE locktype = 'advisory';` in another session - because
  there was no explicit transaction, the lock is already gone by the time you
  can look, since the implicit single-statement transaction has already
  committed. Compare with the same call wrapped in an explicit
  `BEGIN; SELECT pg_advisory_xact_lock(42);` (no `COMMIT` yet) - now it stays
  held until you commit or roll back.
- Compute your own collision-probability table for a lock-key space you
  choose (e.g. a 40-bit key from truncating a hash) using the
  `approxCollisionProbability(n, spaceBits)` helper exported from
  `src/scenarios/uuid-vs-numeric-lock-key.ts`.
