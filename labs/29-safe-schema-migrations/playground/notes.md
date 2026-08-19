# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Connect with `psql "$DATABASE_URL"` and run `\d customers` before and after
  `pnpm scenario:expand-contract` - watch `display_name` appear as a nullable
  `text` column.
- While `pnpm scenario:concurrent-index` or `pnpm scenario:lock-timeout` is
  running, open a second `psql` session and run:
  ```sql
  SELECT pid, mode, granted, relation::regclass
  FROM pg_locks
  WHERE relation = 'customers'::regclass;
  ```
  Watch a real `ShareLock` (plain `CREATE INDEX`) or `AccessExclusiveLock`
  (`ALTER TABLE`) show up as `granted = false` while it waits behind the
  holder transaction's `RowExclusiveLock`.
- Run `docker compose logs postgres | grep -i "lock"` after a
  `scenario:lock-timeout` run - `log_lock_waits=on` makes Postgres itself log
  when a backend has been waiting on a lock for longer than
  `deadlock_timeout`.
- Try setting `statement_timeout` instead of `lock_timeout` on the
  `ALTER TABLE` in `lock-timeout-fail-fast.ts` and compare the behavior -
  `statement_timeout` caps the *entire* statement's runtime (including time
  spent actually executing once the lock is granted), not just the time
  spent waiting for the lock.
- Manually run `CREATE TABLE customers_naive_demo AS SELECT id, full_name
  FROM customers;` and then `ALTER TABLE customers_naive_demo RENAME COLUMN
  full_name TO display_name;` by hand in `psql`, then try `SELECT full_name
  FROM customers_naive_demo;` yourself and read the raw error Postgres
  returns.
- Increase `concurrent-index-vs-blocking.ts`'s `holdMs` and confirm the plain
  `CREATE INDEX` race's duration tracks it almost exactly, while the
  `CONCURRENTLY` race's third-party write duration stays roughly constant
  regardless of how long the holder transaction is held.
