# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Connect with `psql "$DATABASE_URL"` and run the naive transfer's two
  statements by hand in separate `psql` invocations (not the same session) -
  confirm the debit is visible to a third session immediately, before you
  ever run the credit.
- Open two `psql` sessions. In session 1, run `BEGIN;` then the debit
  `UPDATE`, and stop there (do not `COMMIT` or `ROLLBACK` yet). In session 2,
  run `SELECT balance_cents FROM accounts WHERE id = <fromId>;` - confirm you
  see the *old* balance, not the debited one (ordinary Read Committed
  visibility - see Lab 07). Then `COMMIT` session 1 and rerun session 2's
  query.
- Change `naive-transfer.ts`'s injected failure to happen *after* the credit
  statement instead of before it, and confirm the total balance invariant
  holds even in the naive version - the corruption specifically depends on
  where in the sequence the crash lands.
- Try making `performTransactionalTransfer`'s injected failure happen
  *between* `COMMIT` succeeding and the function returning (e.g. throw right
  after `await client.query("COMMIT")`). Confirm the transfer is now
  genuinely `completed` and durable - a "crash after commit" is not a
  correctness problem for atomicity (the transaction is done), though it can
  still confuse a caller who never finds out the commit succeeded. That
  distinction (crash-before-commit vs crash-after-commit-but-before-the-
  caller-hears-back) is exactly why idempotency (Lab 15) matters even with
  transactions.
- Run `pnpm scenario:naive` and `pnpm scenario:transactional` back-to-back
  several times and watch `transfers` accumulate rows in PGweb - filter by
  `mechanism = 'naive' AND status = 'pending'` to see every orphaned,
  never-resolved row the naive mechanism leaves behind.
- Increase the invariant test's `ATTEMPTS` count or failure ratio
  (`i % 3 === 0`) and confirm the total-balance invariant still holds no
  matter how the successful/failed mix changes.
