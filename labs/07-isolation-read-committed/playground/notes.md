# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Open two `psql "$DATABASE_URL"` sessions side by side. In session 1:
  `BEGIN; UPDATE accounts SET balance_cents = balance_cents - 100 WHERE name = 'Scenario Account - Dirty Read';`
  (do not commit). In session 2: `BEGIN; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; SELECT balance_cents FROM accounts WHERE name = 'Scenario Account - Dirty Read'; COMMIT;`
  - confirm by hand that session 2 does not see session 1's uncommitted debit.
- In session 2, instead of `READ UNCOMMITTED`, try `SERIALIZABLE` and repeat
  the non-repeatable-read experiment from `src/scenarios/non-repeatable-read.ts`
  by hand - the second read should now return the SAME value as the first,
  because Serializable (like Repeatable Read) takes one snapshot for the
  whole transaction. That's Lab 08's subject.
- Run `SELECT name, setting FROM pg_settings WHERE name = 'default_transaction_isolation';`
  to see the session-wide default before any `BEGIN`.
- Try `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE` on an already-open
  transaction after it has executed a query, and read the error Postgres
  gives you - isolation level can only be set before the first query in a
  transaction.
