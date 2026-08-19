# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Run `pnpm scenario:naive` several times in a row without resetting the
  database and watch `payments` accumulate more and more duplicate rows for
  each of the two "logical" payees it uses (a fresh `scenarioPayee(...)`
  suffix is generated per *process invocation*, not per attempt, so within
  one run all its own rows share a payee/amount pair you can filter on in
  PGweb).
- Connect with `psql "$DATABASE_URL"` and run:
  ```sql
  SELECT idempotency_key, count(*) FROM payments
  WHERE idempotency_key IS NOT NULL
  GROUP BY idempotency_key
  HAVING count(*) > 1;
  ```
  This should always return zero rows, no matter how many times you've run
  `pnpm scenario:idempotent` or `pnpm scenario:cached-result` - the UNIQUE
  constraint makes more than one row per key structurally impossible.
- Try removing the `ON CONFLICT (idempotency_key) DO NOTHING` clause from
  `performIdempotentPaymentAttempt` (leave the UNIQUE constraint in the
  schema) and rerun the concurrent test - watch it fail with a raw
  `duplicate key value violates unique constraint "payments_idempotency_key_unique"`
  error instead of gracefully returning the cached row. This is the
  difference between "the constraint exists" and "the application actually
  handles the constraint being hit."
- Add an artificial `await new Promise(r => setTimeout(r, 50))` between the
  `INSERT ... ON CONFLICT DO NOTHING` and the fallback `SELECT` in
  `performIdempotentPaymentAttempt`, then rerun the concurrent test with a
  higher `CONCURRENCY` - confirm the result is unchanged (still exactly 1
  row, still identical responses) since the ordering between the INSERT and
  SELECT within one call never affects which row wins the UNIQUE constraint.
- Try changing `naive-retry.ts`'s "fresh key per attempt" variant to instead
  reuse `Date.now()`-based keys with coarse resolution - see how many
  concurrent attempts it takes before two attempts happen to collide on the
  same millisecond and the UNIQUE constraint actually fires by accident. This
  is a good illustration of why a *real* idempotency key needs to be
  generated once per logical request, not derived from something that merely
  usually varies.
