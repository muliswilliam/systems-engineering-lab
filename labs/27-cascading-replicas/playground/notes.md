# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Connect to all three nodes in separate terminals:
  `psql "$PRIMARY_DATABASE_URL"`, `psql "$REPLICA1_DATABASE_URL"`,
  `psql "$REPLICA2_DATABASE_URL"`. Insert on the primary, watch the row
  arrive on replica-1, then on replica-2 - it always arrives on replica-1
  first (or at the exact same instant, never later).
- On the primary, run `SELECT * FROM pg_stat_replication;` - only one row
  (replica-1). Now run the SAME query on replica-1's own `psql` session -
  a different one row (replica-2). Now run it on replica-2 - zero rows.
- `docker stop lab27-replica-1`, write a few rows to the primary, then
  `docker start lab27-replica-1` and watch both replica-1 and replica-2
  catch up - replica-2 has no way to know anything happened until
  replica-1 itself reconnects and re-forwards.
- Increase `REPLICA1_DELAY_MS`/`REPLICA2_DELAY_MS` in
  `src/scenarios/cascading-lag.ts` and see how the additional-hop lag
  scales.
- Try adding a FOURTH node, `replica-3`, with
  `POSTGRESQL_MASTER_HOST: replica-2` - confirm `pg_stat_replication` on
  replica-2 now shows one row too, and the primary's still shows exactly
  one.
- Compare this lab's `docker stop`/`docker start` (container keeps its data
  volume, replica-1 reconnects and catches up from where it left off) against
  a full `docker compose down -v && docker compose up -d` (replica-1's data
  volume is destroyed, so it must re-bootstrap its ENTIRE base backup from
  the primary from scratch) - watch how much longer the second path takes.
