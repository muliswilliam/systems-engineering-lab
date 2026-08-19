# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Open two `psql "$DATABASE_URL"` sessions side by side. In session 1:
  `BEGIN; SET TRANSACTION ISOLATION LEVEL REPEATABLE READ; SELECT balance_cents FROM accounts WHERE name = 'Scenario Account - Repeatable Read Snapshot';`
  (leave it open). In session 2:
  `BEGIN; UPDATE accounts SET balance_cents = balance_cents + 25000 WHERE name = 'Scenario Account - Repeatable Read Snapshot'; COMMIT;`
  Back in session 1, run the same `SELECT` again - confirm by hand it still
  shows the OLD value, then `COMMIT` and run it a third time to see the
  now-visible new value in a fresh transaction.
- Repeat the concurrent-write-conflict scenario by hand with two `psql`
  sessions, but this time do NOT commit session 1 before issuing the
  `UPDATE` in session 2 - session 2's `UPDATE` will visibly hang (blocked on
  the row lock) until you commit session 1, and only then does session 2's
  terminal print the `40001` error. This is a good way to feel the
  "wait, then fail" case described in the Postgres docs, versus this lab's
  scripted "fully sequential" version which produces the identical error
  without the wait.
- Try the concurrent-write-conflict scenario under `SERIALIZABLE` instead of
  `REPEATABLE READ` on both sessions - the failure mode looks similar
  (`could not serialize access due to concurrent update`), which is worth
  noticing before Lab 09 draws the sharper distinction (Serializable also
  catches write skew; Repeatable Read does not).
- Try the write-skew scenario under `SERIALIZABLE` on both sessions by hand:
  `BEGIN; SET TRANSACTION ISOLATION LEVEL SERIALIZABLE; SELECT is_on_call FROM on_call_staff WHERE name = 'Scenario Staff - Dr. Boyko';` in session 1,
  the mirror image in session 2, then have each `UPDATE` its own row and
  `COMMIT`. One of the two commits should now fail with `ERROR: could not
  serialize access due to read/write dependencies among transactions`
  (SQLSTATE 40001) - Serializable Snapshot Isolation catches the dangerous
  structure that Repeatable Read let through. This previews Lab 09.
- Fix the write-skew scenario at the application level without changing
  isolation level: rewrite both transactions to
  `SELECT ... FROM on_call_staff WHERE id IN (...) FOR UPDATE` before
  deciding whether it's safe to go off call, and confirm the second
  transaction now blocks on the first transaction's row lock until it
  commits, then re-reads a value that reflects the first transaction's
  write. This is the `SELECT ... FOR UPDATE` fix referenced in the README's
  "Fix it" section (full treatment in Lab 10).
- Run `SELECT relname, seq_scan, idx_scan FROM pg_stat_user_tables WHERE relname IN ('accounts', 'on_call_staff');`
  before and after a batch of scenario runs to see how much of this lab's
  traffic is sequential scans on these tiny tables.
