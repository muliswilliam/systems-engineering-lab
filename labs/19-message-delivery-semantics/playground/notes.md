# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Open `src/delivery/network.ts` and change one scenario's `NetworkScript`
  `outcomes` array (e.g. `["ack_lost", "ack_lost", "success"]` in a copy of
  `at-least-once.ts`) and watch `delivery_log` grow a third row - the retry
  mechanism itself is bounded by `retry.maxAttempts`, not by the script
  length.
- Set `retry.maxAttempts` to `1` in a scratch copy of `at-least-once.ts`'s
  ack-loss case and confirm it degrades to exactly at-most-once's behavior
  (1 attempt, no retry, `acked: false`) - a concrete way to see that
  at-most-once is really just at-least-once with zero retries.
- Connect with `psql "$DATABASE_URL"` and run:
  ```sql
  SELECT n.scenario, n.status, n.receiver_processed_count,
         (SELECT count(*) FROM delivery_log dl WHERE dl.message_id = n.id) AS attempts
  FROM notifications n
  ORDER BY n.created_at;
  ```
  to see every scenario's transport-attempt count next to its business-effect
  count in one place.
- Try adding a FOURTH scenario file, `src/scenarios/exactly-once-illusion.ts`,
  that attempts to "solve" duplicates by having the sender check
  `delivery_log` for a prior `delivered_acked` row before retrying (instead
  of the receiver being idempotent). Convince yourself this still has a race:
  the sender's check-then-retry is not atomic with the receiver's actual
  processing, so a sender crash between the check and the retry can still
  double-deliver. This is why idempotency belongs on the receiver, not the
  sender's retry logic.
- Increase `pnpm seed --size=medium` or `--size=large` and watch
  `receiver_processed_count` accumulate consistently across many independent
  instances of the same scenario in PGweb - the invariant (0, 1, 1, 2, 1 for
  the five scenarios respectively) should hold identically no matter how many
  instances you seed.
