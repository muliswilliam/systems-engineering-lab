# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Run `pnpm scenario:failover`, then immediately try connecting with
  `psql "$PRIMARY_DATABASE_URL"` - watch the connection itself fail
  (`ECONNREFUSED` / "connection refused"), not a SQL-level error.
- After promotion, run `psql "$REPLICA_DATABASE_URL" -c "SELECT pg_is_in_recovery();"`
  yourself and see it return `f` - the exact same connection string that
  returned `t` a moment ago.
- Time how long `SELECT pg_promote(true, 60);` takes by hand in `psql`
  against a freshly-stopped-primary topology, and compare it to this lab's
  own scripted measurement.
- Run `pnpm scenario:split-brain`, then open PGweb for BOTH nodes
  (http://localhost:8428 and http://localhost:8528) side by side and browse
  `widgets` on each - see the divergence yourself instead of only reading
  the log output.
- Try `docker compose start primary` (without ever calling `pg_promote()`
  first) right after `docker compose stop primary` - a normal
  stop/start with NO promotion in between. Confirm the replica silently and
  correctly reconnects and catches back up, the same reconnect-and-catch-up
  path Lab 24's README describes - this is the "boring," non-failover case
  this lab deliberately contrasts against.
