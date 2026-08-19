# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Connect to the primary with `psql "$PRIMARY_DATABASE_URL"` and to the
  replica with `psql "$REPLICA_DATABASE_URL"` in two separate terminals.
  Run `INSERT INTO widgets (name, value) VALUES ('manual-test', 1);` on the
  primary, then `SELECT * FROM widgets WHERE name = 'manual-test';` on the
  replica and watch it appear.
- On the replica, run `SELECT pg_is_in_recovery();` - it returns `t`. Try
  the same INSERT directly on the replica's `psql` session and read the
  real error yourself.
- On the primary, run `SELECT * FROM pg_stat_replication;` and watch
  `replay_lsn` change as you insert more rows.
- `docker compose stop replica` then `docker compose start replica` and
  watch it reconnect and catch back up - check `pg_stat_replication` on the
  primary again once it's healthy.
- Try increasing `BURST_SIZE` in `src/scenarios/artificial-replication-lag.ts`
  and see whether the observed lag grows.
