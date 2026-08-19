# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests.

Ideas to try:

- Connect straight to Postgres and watch connection count in real time:
  `watch -n1 "psql \"$DATABASE_URL\" -c \"select count(*) from pg_stat_activity\""`.
- Connect to either PgBouncer instance's admin console and poke around:
  `psql "$DATABASE_URL_PGBOUNCER_TRANSACTION" -d pgbouncer -c "SHOW POOLS;"`
  (note the `-d pgbouncer` - the admin console lives at a virtual database
  name, not the lab's own `lab23` database).
- Try `SHOW CLIENTS;` and `SHOW SERVERS;` on the admin console while a
  scenario script is running in another terminal - you can watch client
  connections queue (`SHOW CLIENTS`, `state = waiting`) when the pool is
  smaller than the concurrent client count.
- Open a `psql` session through the session-pooling instance
  (`psql "$DATABASE_URL_PGBOUNCER_SESSION"`) and run `SELECT pg_backend_pid();`
  several times in a row - it never changes for the life of that psql
  session. Do the same through the transaction-pooling instance and watch it
  change between statements once other traffic is happening concurrently.
- Try `CREATE TEMP TABLE` and a second statement referencing it, once through
  each PgBouncer instance, to see temp tables (session-scoped Postgres state)
  fail unpredictably under transaction pooling.
