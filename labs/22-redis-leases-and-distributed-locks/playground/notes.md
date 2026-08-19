# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Open `redis-cli -p 6422` in one terminal. Run `SET foo bar NX PX 5000`,
  confirm `OK`. Run it again immediately - confirm it now returns `(nil)`
  because the key already exists. Wait 5 seconds and run it a third time -
  confirm it returns `OK` again, because the key expired.
- With the same `redis-cli` session, run `GET foo` to see the current
  owner token, then in a second `redis-cli` session try `DEL foo` directly -
  notice nothing stops you, because a plain `DEL` (unlike this lab's
  `releaseLock`) does not check any token at all. This is the same class of
  bug as `releaseLockUnsafeGetThenDel` in `src/redis-lock/basic-lock.ts`,
  just with the "check" step skipped entirely instead of merely
  non-atomic.
- In `src/redis-lock/lease-expiry-bug.ts`, change `WORKER_B_START_DELAY_MS`
  to something LESS than `LOCK_TTL_MS` (e.g. 50) and rerun
  `pnpm scenario:lease-expiry-bug` - confirm worker B's acquisition now
  fails (`lockAcquired: false`), because A's real TTL has not expired yet.
  This is the "working as intended" case the bug scenario deliberately
  avoids by choosing a start delay greater than the TTL.
- In `src/redis-lock/fencing-token.ts`, try commenting out the
  `WHERE fencing_token < $1` clause in `writeResourceStateFenced`
  (`src/redis-lock/support.ts`) and rerun `pnpm scenario:fencing-token` -
  confirm the fix disappears and you're back to lease-expiry-bug.ts's
  outcome (both writes succeed, last-writer-wins), even though the fencing
  tokens are still being generated and recorded. The tokens alone do
  nothing; the conditional `UPDATE` is what enforces the guarantee.
- In `src/redis-lock/lease-renewal.ts`, shrink `renewIntervalMs` to be
  larger than `ttlMs` in `demonstrateSuccessfulRenewal`'s call in `main()` -
  confirm the "successful" renewal demo now behaves like the pause demo,
  since a renewal that runs less often than the TTL window is functionally
  the same failure mode as a paused renewal loop.
- Connect to Redis with `redis-cli -p 6422 MONITOR` in a separate terminal
  and rerun any scenario script - watch the exact `SET ... NX PX`, `GET`,
  `DEL`, `EVAL`, and `INCR` commands each one sends, in the order they were
  actually sent to Redis.
