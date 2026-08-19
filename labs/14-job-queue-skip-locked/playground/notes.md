# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Open `psql "$DATABASE_URL"` and run the claim query by hand inside an
  explicit transaction (`BEGIN;` then the `SELECT ... FOR UPDATE SKIP LOCKED
  LIMIT 1;`), and leave the transaction open. In a second `psql` session, run
  the same query - confirm it returns a *different* row instantly instead of
  blocking, then go back to the first session and `COMMIT`.
- Repeat the above but drop `SKIP LOCKED` from the query in both sessions -
  confirm the second session's query now hangs until the first session
  commits or rolls back, even though other pending rows exist.
- Run `pnpm scenario:five` twice in a row without reseeding - the second run
  should log `pendingBefore: 0` and do nothing, since the queue already
  drained.
- Watch `docker compose logs postgres -f` while running `pnpm scenario:fifty`
  - look for the literal `FOR UPDATE SKIP LOCKED` statement repeated once per
  claim, and notice there is no `pg_locks` pileup the way there would be with
  plain `FOR UPDATE` (see `tests/integration/for-update-vs-skip-locked.test.ts`
  for the measured contrast).
- Lower `SHORT_LEASE_MS` in `src/scenarios/lease-expiry-reclaim.ts` to 50ms
  and rerun - confirm the mechanism still works down to very short leases,
  then think about why a lease this short would be risky in production (a
  slow-but-still-alive worker could get its job reclaimed out from under it).
- Change `retries-and-failure.ts`'s `MAX_ATTEMPTS` and rerun - confirm the
  number of `job_attempts` rows for that job always equals whatever
  `maxAttempts` you set.
- In PGweb, filter `jobs` by `status = 'processing' AND locked_until < now()`
  - in a healthy running system this should always return 0 rows; a nonzero,
  growing count is exactly what a stuck/crashed-worker monitor would alert
  on in production.
