# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Open `psql "$DATABASE_URL"` and run `pnpm scenario:naive-broker-fails`
  while watching `SELECT * FROM orders ORDER BY id DESC LIMIT 1;` and
  `SELECT * FROM outbox_events ORDER BY id DESC LIMIT 1;` in a second
  terminal - confirm a new order row appears but no new outbox_events row
  ever does.
- Run `pnpm scenario:naive-db-fails` and watch `docker compose logs postgres`
  (with `log_statement=all`) - find the failed `INSERT INTO orders` statement
  and its SQLSTATE 23514 error, and notice there is no corresponding
  `ROLLBACK` because there was never a `BEGIN` - the single INSERT statement
  is its own atomic (and here, rejected) unit of work.
- Run `pnpm scenario:outbox` and watch the same Postgres logs for the happy
  path vs the injected-failure path - compare the `BEGIN` ... `COMMIT`
  sequence against `BEGIN` ... `ROLLBACK`, and confirm the order INSERT
  really did execute (and get undone) in the rollback case, not merely
  "skipped."
- Change `src/scripts/drain-outbox.ts`'s injected failure test to leave a
  real unpublished row behind, then open PGweb at http://localhost:8416 and
  filter `outbox_events` by `published_at IS NULL` - this is the exact query
  Lab 17's `SKIP LOCKED` publisher workers will poll on.
- Try running two `pnpm outbox:drain` invocations at the same moment (e.g.
  `pnpm outbox:drain & pnpm outbox:drain`) against a database with several
  unpublished events, and see whether the same event ever gets published by
  both processes - this drain script does not use `FOR UPDATE SKIP LOCKED`,
  so nothing prevents that race. That gap is exactly what Lab 17 fixes.
- Add a `pg_sleep` or an artificial delay between the drain script's
  `publish(...)` call and its `UPDATE outbox_events SET published_at = ...`
  statement, then kill the process (Ctrl-C) mid-sleep. Rerun the drain and
  confirm the event gets published again - a second, real duplicate
  publish - which is exactly why Lab 18's idempotent consumers exist.
- Add a third, independent aggregate type (e.g. `'refund'`) to the
  `outbox_events_aggregate_type_valid` CHECK and a matching event type, and
  think through why a generic outbox table used across many aggregate types
  usually cannot carry a single `aggregate_id` foreign key the way this
  lab's schema does (see README.md "Tradeoffs").
