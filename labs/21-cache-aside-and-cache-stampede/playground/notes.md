# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- `redis-cli -p 6421 monitor` in one terminal while running
  `pnpm scenario:naive-stampede` in another - watch every `GET`/`SET`
  command fly by and count them yourself against the logged
  `databaseCallCount`.
- `redis-cli -p 6421 --latency` while a scenario runs, to get a feel for how
  cheap Redis round-trips are relative to the 75ms simulated database delay.
- Lower `SIMULATED_QUERY_DELAY_MS` in `src/db/product-repository.ts` to 10ms
  and rerun `pnpm scenario:lease` a few times - does the documented
  "close to 1, tolerance 2" database-call count ever actually hit 2 on your
  machine? What does that tell you about how `leaseMs` relates to the
  underlying operation's real latency?
- Add a `console.time`/`console.timeEnd` (or a Pino `attempt` field) inside
  `lease-based-refill.ts`'s retry loop and watch how many attempts a waiter
  needs when you deliberately set `leaseMs` shorter than
  `SIMULATED_QUERY_DELAY_MS`.
- Try seeding the jittered-TTL demo with `jitterFraction: 0` and confirm the
  jittered set's measured spread collapses to look just like the fixed set's.
