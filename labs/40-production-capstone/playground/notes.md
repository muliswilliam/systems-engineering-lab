# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Connect with `psql "$DATABASE_URL"` and run `\d orders` / `\d outbox_events`
  to see the `orders_idempotency_key_key` UNIQUE constraint and the
  `outbox_events_status_created_at_idx` index Drizzle generated.
- While `pnpm scenario:composed-duplicate-storm` is running, open a second
  terminal and poll `curl -s http://localhost:${METRICS_PORT:-9440}/metrics |
  grep capstone_` every 200ms (needs `pnpm dev` running in a third terminal to
  host the metrics server) to watch counters move in near-real time.
- Change `createProtectedWorker`'s `cooldownMs` down to something short
  (e.g. 100ms) in `composed-duplicate-checkout-storm.ts` and rerun - you
  should see the breaker recover into HALF_OPEN and, if the downstream is
  still `down`, immediately reopen; watch the structured log lines for the
  `{"from":"OPEN","to":"HALF_OPEN", ...}` / `{"from":"HALF_OPEN","to":"OPEN", ...}`
  transitions.
- Change the naive scenario's notification health from `"degraded"` to
  `"down"` and watch how much longer draining takes with no breaker at all
  compared to the composed scenario's protected worker under the same
  downstream health.
- Query `SELECT correlation_id, outcome, breaker_state, latency_ms, created_at
  FROM notification_attempts ORDER BY created_at;` after either storm
  scenario to reconstruct, in order, exactly what an operator would see
  during the incident.
- Try raising `DUPLICATE_REQUESTS` in both storm scenarios from 20 to 200 and
  confirm the composed scenario's downstream call count barely changes while
  the naive scenario's grows roughly linearly - that gap IS this lab's thesis.
