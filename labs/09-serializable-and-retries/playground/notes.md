# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Open two `psql "$DATABASE_URL"` sessions side by side and reproduce the
  write-skew scenario by hand:
  - Session 1: `BEGIN; SET TRANSACTION ISOLATION LEVEL REPEATABLE READ; SELECT count(*) FROM on_call_staff WHERE team = 'ER Night Shift - Write Skew' AND is_on_call = true AND name != 'Dr. Alice Chen';`
  - Session 2: same query excluding Bob instead.
  - Session 1: `UPDATE on_call_staff SET is_on_call = false WHERE name = 'Dr. Alice Chen'; COMMIT;`
  - Session 2: `UPDATE on_call_staff SET is_on_call = false WHERE name = 'Dr. Bob Nkemelu'; COMMIT;`
  - Then: `SELECT name, is_on_call FROM on_call_staff WHERE team = 'ER Night Shift - Write Skew';` - both `false`.
- Repeat the exact same by-hand sequence but with
  `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE` in both sessions - watch
  session 2's final `COMMIT` fail with
  `ERROR: could not serialize access due to read/write dependencies among transactions`
  (SQLSTATE 40001), and confirm `pg_stat_activity`/the error message names
  the failed transaction.
- Run `SELECT name, setting FROM pg_settings WHERE name LIKE '%serializable%';`
  to see `default_transaction_isolation` and related SSI settings
  (`max_pred_locks_per_transaction`, etc.).
- While a Serializable transaction is open mid-way through the scenario,
  query `SELECT * FROM pg_locks WHERE mode = 'SIReadLock';` in a third
  session to see the predicate locks SSI is tracking.
- Increase `CONTENTION_STAFF` in `src/seed/scenario-staff.ts` from 5 to 10 or
  20 members and rerun `pnpm scenario:contention` - predict, then confirm,
  whether `totalConflicts` grows faster or slower than staff count.
- In `src/scenarios/serializable-with-retry.ts`, set `maxAttempts` very low
  (e.g. 1) and rerun under load - watch the retry loop legitimately throw
  "exhausted N attempts" instead of silently accepting a wrong answer; this
  is why retry loops must be bounded AND fail loudly, not swallow the error.
- Try changing `FIRST_ATTEMPT_DELAY_MS` in `contention-and-throughput.ts` to
  `0` and rerun the Serializable scenario a few times - with no forced
  overlap, some runs may resolve with zero conflicts purely because the
  workers happened not to race. This is the same "worked on my machine"
  trap real concurrency bugs hide behind - the delay exists specifically to
  make the race observable on every run.
