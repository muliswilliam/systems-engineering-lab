# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Connect with `psql "$DATABASE_URL"` and run `\d outbox_events` to see the
  exact column types, the `outbox_events_status_valid` CHECK, and the
  `outbox_events_status_created_at_idx` index Drizzle generated.
- While `pnpm scenario:parallel-publishers` is running (increase
  `--size=large` first so there's more to drain), open a second terminal and
  poll `SELECT status, count(*) FROM outbox_events GROUP BY status;` every
  100ms to watch `pending` drain into `processing` and then `published` in
  real time.
- Run `SELECT pid, query, state FROM pg_stat_activity WHERE query LIKE
  '%outbox_events%';` from a third terminal during a drain to see the claim
  transactions as they happen.
- Change `crashed-publisher-duplicate-delivery.ts`'s `LEASE_MS` to something
  much longer (e.g. 5000ms) and watch how long you have to wait before worker
  B can reclaim - the duplicate is still guaranteed to happen, just later.
- Try changing the broker to `{ mode: "slow", slowMs: 400 }` with a short
  lease (e.g. 200ms) in `parallel-publishers.ts` and rerun the drain - now
  even the "happy path" scenario can produce a reclaim, because the broker
  call itself outlives the lease. This is the same root cause as the crash
  scenario, without any crash at all: a lease is a timeout, not a promise
  that the original worker died.
- Query `SELECT event_public_id, processed_at FROM processed_events;` after
  running `pnpm scenario:idempotent-preview` and confirm there is exactly one
  row, not two, despite two broker deliveries.
