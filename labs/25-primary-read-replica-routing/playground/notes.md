# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Write `classifyBroken` yourself: a THIRD classify table that gets exactly
  one kind wrong (e.g. routes `write` to the replica). Wire it into a
  temporary router and see which scenario/test catches it - does the
  failure look like a stale read or a hard Postgres error?
- In `src/scenarios/corrected-router-read-after-write.ts`, change
  `ARTIFICIAL_DELAY_MS` to `0` and rerun - both strategies should still
  report `staleCount: 0`, but the LSN-wait strategy's `avgReadLatencyMs`
  should drop close to the route-to-primary strategy's, since there is
  almost nothing to wait for.
- Connect with `psql "$REPLICA_DATABASE_URL"` and manually try
  `BEGIN; SELECT stock_quantity FROM products LIMIT 1 FOR UPDATE; COMMIT;`
  - read the exact real error yourself instead of trusting the scenario's
    captured log line.
- Add a `read-your-own-writes` cache (an in-memory map of `productId ->
  lastWrittenPriceCents` with a short TTL) as a FOURTH read-after-write
  strategy alongside route-to-primary and LSN-wait - what does it get
  right/wrong compared to the other two once a SECOND process is the one
  doing the reading?
