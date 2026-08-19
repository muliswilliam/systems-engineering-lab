# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Run `pnpm scenario:naive` several times in a row and watch `accounts.balance_cents`
  climb in PGweb every single time, even though each run only "means" to
  deliver one logical credit event.
- Open `src/scenarios/racy-check-then-insert-consumer.ts` and change the
  `delayMs` argument passed to `applyRacy` in `main()` to `0`. Rerun
  `pnpm scenario:racy` several times - the race becomes intermittent instead
  of guaranteed, which is exactly why the lab's test uses a deliberate delay
  to make the failure reliably observable instead of flaky.
- Connect with `psql "$DATABASE_URL"` and run:
  ```sql
  SELECT message_id, account_id, amount_cents, processed_at
  FROM processed_messages
  ORDER BY processed_at DESC
  LIMIT 20;
  ```
  after running each scenario script, and compare how many rows exist per
  distinct `message_id` (should always be at most 1 - even the racy
  consumer's dedup table stays clean, only the account balance doesn't).
- Try increasing `idempotent-consumer.test.ts`'s `WORKER_COUNT` from 20 to
  100 or 200 and confirm `appliedCount` is still always exactly 1.
- Try changing `idempotent-consumer.ts`'s `ON CONFLICT (message_id) DO
  NOTHING` to a plain `INSERT` with no `ON CONFLICT` clause, then rerun the
  concurrent test - watch it fail with a raw unpredictable mix of
  successes and `23505` errors instead of the clean "applied" vs "duplicate"
  outcomes the `ON CONFLICT` clause produces.
