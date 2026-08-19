# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- `redis-cli -p 6436 monitor` in one terminal while running
  `pnpm scenario:rate-limit-sliding-window` in another - watch the
  `ZREMRANGEBYSCORE`/`ZCARD`/`ZADD` sequence the Lua script issues atomically
  for every single request.
- Lower `ACQUIRE_TIMEOUT_MS` in `src/scripts/run-naive-overload.ts` and watch
  `failed` climb even higher for the same burst size - the timeout budget is
  what caps how many requests the downstream can ever serve.
- In `src/scripts/run-backpressure-bounded.ts`, try raising `CAPACITY` toward
  `PHASE1_BURST_SIZE` and see the accepted/rejected split shift - at what
  capacity does Phase 1 stop rejecting anything at all?
- In `src/scripts/run-rate-limit-insufficient.ts`, raise `DOWNSTREAM_CAPACITY`
  until `downstreamTimedOut` reaches 0 while `REQUEST_COUNT` stays fixed -
  that's the concurrency the downstream actually needs to sustain this rate
  without a queue.
- Try implementing a third rate-limiting algorithm - a fixed window counter
  (a single Redis `INCR` + `EXPIRE` per window, no sorted set or hash needed)
  - and reproduce the classic boundary problem: fire a burst straddling a
    window reset and see up to ~2x the configured limit get through.
