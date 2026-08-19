# Lab 22 - Redis Leases and Distributed Locks

## Why this exists

Sooner or later someone on a team reaches for "let's just put a Redis lock
around it" to stop two processes from doing the same piece of work at the
same time. Sometimes that is the right call. Very often it is not - the
invariant already lives in PostgreSQL and a transaction, a conditional write,
a unique constraint, or an advisory lock (Lab 13) would protect it more
directly, with fewer moving parts and fewer failure modes to reason about.

This lab teaches distributed locks as an **advanced coordination mechanism**,
not a default answer. It builds a real Redis lock from scratch (`SET key
value NX PX`, an ownership token, an atomic release), then deliberately
breaks it the way real production incidents break it: a lock with a short
TTL protecting work that takes longer than the TTL. The lease expires while
the holder is still working, a second process acquires the "same" lock, and
both processes end up believing they exclusively own it - a real,
observable double-processing bug, not a hypothetical one. The fix is not
"pick a longer TTL" (there is no TTL long enough to be safe against a
process that can pause for an unbounded amount of time); the fix is a
**fencing token** that lets the downstream resource - here, a Postgres row -
reject a write from a stale lock holder, even when that holder never
realized its lease had expired.

Every mechanism in this lab is compared explicitly against what CLAUDE.md
calls "datastore-native guarantees": a Postgres transaction, a conditional
write, a unique constraint, and an advisory lock. The core lesson is not
"Redis locks are bad" - it is that a lock coordinates *processes*, while a
constraint or conditional write protects *data*, and conflating the two is
where these bugs come from.

## Learning objectives

After this lab you should be able to:

- implement an atomic acquire-if-absent-with-expiration lock using `SET key
  value NX PX ttl`, and explain why `NX` and `PX` must be part of the same
  command rather than two separate calls;
- explain why a lock's value must be a fresh, unguessable **ownership
  token** generated per acquisition, not a fixed string or the key's own
  name, and why blindly `DEL`-ing a key by name is unsafe;
- implement a safe release as a single atomic operation (a Lua script run
  via `EVAL`) that checks the token and deletes the key in one round trip,
  and explain precisely why "GET, then compare in application code, then
  DEL" is NOT atomic and is a real, reproducible bug;
- reproduce, against a real running Redis and Postgres, the classic lease-
  expiry bug: a lock's TTL elapses while its holder is still doing the work
  it was meant to protect, a second holder acquires the "same" lock, and
  both end up writing to shared state with overlapping wall-clock windows
  and no error raised anywhere;
- implement and reason about **fencing tokens**: a monotonically increasing
  number handed out at lock-acquisition time that lets a downstream resource
  reject a write from a stale holder via a conditional `UPDATE ... WHERE
  fencing_token < $1` - and explain precisely why this does NOT stop the
  lock from expiring, only stops the expired holder's write from landing;
- implement lease renewal (a heartbeat that periodically extends a lease's
  TTL while work is still in progress) as the complementary, best-effort
  alternative to fencing tokens, and explain the specific edge case (a GC
  pause or process suspend longer than the TTL) where renewal cannot help
  and fencing tokens still can;
- explain, without code, why no lock manager - Redis, Postgres advisory
  locks, ZooKeeper, anything - can fully solve the "the holder is not dead,
  just slow or partitioned" problem, and why fencing tokens are the standard
  answer to that specific limitation;
- state, for this exact scenario, when reaching for Redis coordination is
  actually justified versus when a Postgres transaction, conditional write,
  unique constraint, or advisory lock would have been simpler and safer.

## Architecture

```text
┌────────────────────────────┐        ┌───────────────────────────┐
│ src/redis-lock/              │        │                           │
│  basic-lock.ts                │──────▶│          Redis            │
│  (SET NX PX / atomic EVAL     │◀──────│   lock:resource:<name>    │
│   release / the naive-        │        │   fencing:resource:<name>│
│   GET-then-DEL bug)           │        └───────────────────────────┘
│  lease-expiry-bug.ts          │
│  (THE bug: TTL < work time)   │        ┌───────────────────────────┐
│  fencing-token.ts             │──────▶│                           │
│  (THE fix: conditional write) │        │       PostgreSQL          │◀── pgweb
│  lease-renewal.ts             │──────▶│      resource_state        │
│  (complementary heartbeat)    │        │                           │
├────────────────────────────┤        └───────────────────────────┘
│ src/seed/seed.ts - fixed          │                     ▲
│ "Scenario Resource - ..." rows +   │              migrate.ts
│ faker "browsing" rows, resets      │
│ Redis scenario keys on every run  │
└────────────────────────────┘
```

Domain: a fresh, self-contained `resource_state` table - a single shared
mutable resource that multiple independent "workers" (separate Node
processes/connections in spirit, modeled here as concurrent `async`
functions each with their own Redis connection and their own Postgres pool
query) coordinate write access to via a Redis lock before writing. This is
not one of SPEC.md section 8.2's five named domains (payroll/ticketing/
commerce/banking/background-processing) - the concept this lab teaches is
the lock/lease/fencing mechanism itself, and a richer relational model
around it would only add noise, the same rationale Lab 06's `counters` and
Lab 11's `documents` document for their own minimal standalone tables.

`fencing_token` is a plain `bigint` column on the row itself, deliberately
NOT a Redis-only concept - the whole point of the fix is that the
downstream datastore enforces the guarantee via an ordinary conditional
`UPDATE`, exactly the pattern Lab 11 teaches for optimistic concurrency,
just using a lock-issued token instead of an app-managed version counter.

No import from Lab 13 (advisory locks) or Lab 21 (cache-aside/cache
stampede, also adding Redis to this repository concurrently) - per the
independent-labs principle this lab owns its own Docker Compose stack,
schema, and Redis usage end to end.

## Setup

```bash
pnpm install
cp labs/22-redis-leases-and-distributed-locks/.env.example labs/22-redis-leases-and-distributed-locks/.env
cd labs/22-redis-leases-and-distributed-locks
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate
pnpm seed
```

Open PGweb at http://localhost:8422 (it auto-connects via
`PGWEB_DATABASE_URL`). You should see `resource_state` with two fixed
"Scenario Resource - ..." rows plus a handful of faker-generated "browsing"
rows (feature flags, pricing tiers, inventory locks, report jobs - a
plausible shared-config/coordination domain).

Redis is reachable at `redis://localhost:6422` (`redis-cli -p 6422 ping`
should return `PONG`).

## Scenario

Multiple independent workers need to coordinate exclusive access to a shared
resource before writing to it - imagine a scheduled job that rebuilds a
cached report, a config-sync process, or a leader-election-style "only one
instance should currently be doing this" task. Postgres is not already in
the write path for the *coordination* decision (only for the eventual
write), so the team reaches for a Redis-based lease: acquire a short-lived
lock, do the work, write the result, release the lock. This lab builds that
lease correctly, then shows exactly how "correctly" still has a sharp edge -
the lease's TTL is a guess about how long the work will take, and guesses
are sometimes wrong.

## Prediction

Before running anything, predict:

1. Two workers call `SET key token NX PX 5000` on the exact same key at the
   same instant. Can both succeed? Can neither?
2. A worker holds a lock. A completely different worker, holding a
   different, unrelated token, calls the atomic release function on the
   SAME key. Does it succeed? What happens to the real owner's lock?
3. Worker A acquires a lock with a 200ms TTL, then does 400ms of "work"
   without ever renewing or re-checking the lock. Worker B checks the same
   key 250ms after A acquired it. Does B's acquisition succeed or fail?
4. In the scenario above, both A and B write to the same Postgres row
   after "finishing their work." Does Postgres raise an error? Which
   worker's value ends up in the row?
5. Now every lock acquisition also hands out a fencing token via `INCR`.
   Worker A got token 1, worker B got token 2 (because B acquired second).
   A's write finally arrives, carrying token 1, arriving in Postgres AFTER
   B's write (carrying token 2) already landed. Does A's write succeed?
6. A worker renews its lease every 60ms against a 200ms TTL while doing
   1000ms of work. Does a competing worker ever manage to acquire the lock
   during that window? Now suppose the renewing worker's process is paused
   (GC, container suspend) for 500ms in the middle of that work. Does the
   answer change?

## Exercise

1. Run the setup commands above.
2. Run `pnpm scenario:basic-lock` - two workers race for the same key
   (exactly one wins), a worker with the wrong token fails to release a
   lock it doesn't own (the key survives untouched), and a deliberately
   unsafe "GET then DEL as two separate commands" release is shown actually
   deleting a *different* owner's lock after a real expiry-and-reacquire
   gap.
3. Run `pnpm scenario:lease-expiry-bug` - THE central bug. Read the
   timestamps carefully: worker B acquires its lock before worker A's write
   lands, proving both workers genuinely believed they held the lock at the
   same moment in wall-clock time.
4. Run `pnpm scenario:fencing-token` - the identical interleaving, but now
   worker A's late write is rejected outright (`rowCount: 0`) by a
   conditional `UPDATE`, even though A's own code has no idea its lease
   expired.
5. Run `pnpm scenario:lease-renewal` - a heartbeat keeps a lease alive
   across work far longer than one TTL window, then a simulated pause
   longer than the TTL shows renewal's limit: the lock IS stolen, and the
   paused holder's later renewal attempt correctly fails rather than
   silently reasserting ownership.
6. Run `pnpm test` and read the assertions - they check real acquire/
   release booleans, real fencing-token values, and real Postgres
   `rowCount`s, not timing or log output.

## Observe

- **PGweb** (http://localhost:8422): browse `resource_state` after running
  `pnpm scenario:lease-expiry-bug` and `pnpm scenario:fencing-token` and
  compare `fencing_token`/`last_writer` between the two rows - one shows
  the "wrong" worker won by writing last, the other shows the correct
  (higher-token) worker won regardless of write order.
- **`redis-cli -p 6422 MONITOR`**: run this in a separate terminal before
  any scenario script and watch the exact `SET ... NX PX`, `GET`, `DEL`,
  `EVAL`, `INCR`, and `PEXPIRE` commands each scenario sends, in order.
- **`redis-cli -p 6422 TTL lock:resource:...`**: while `lease-expiry-bug`'s
  worker A is "working" (add a longer `WORKER_A_WORK_MS` to watch it live),
  watch the TTL count down to 0 and the key disappear entirely - a real
  expiry, not a simulated one.
- **Structured logs**: every scenario logs through `@labs/logging` (Pino),
  including real captured `lockAcquiredAtMs`/`writeAttemptedAtMs` offsets
  from a shared `t0`, fencing token values, and Postgres `rowCount`s - see
  "Real validation run" below for exact captured numbers.

## Break it

Run `pnpm scenario:lease-expiry-bug` and look at a real captured run (from
this lab's own validation - see below for the full output):

```json
{"workerId":"worker-A","lockAcquired":true,"lockAcquiredAtMs":0,"writeAttemptedAtMs":401,"writeRowCount":1}
{"workerId":"worker-B","lockAcquired":true,"lockAcquiredAtMs":261,"writeAttemptedAtMs":362,"writeRowCount":1}
{"bothBelievedTheyHeldTheLockAtTheSameTime":true}
{"finalRow":{"fencingToken":0,"lastWriter":"worker-A"}}
```

Worker A's `SET NX PX 200` genuinely succeeded, and 261ms later - well past
the 200ms TTL - worker B's `SET NX PX 200` on the *same key* also genuinely
succeeded, because the key had genuinely expired. Both workers' internal
state says "I hold this lock." Both call `UPDATE resource_state SET
last_writer = ...` and both get `rowCount: 1` back - Postgres has no idea
these two writers think they're mutually exclusive, because nothing told it
that. The final row shows `last_writer: "worker-A"`, not because A "won" any
race, but simply because A's write happened to land chronologically last
(401ms vs. B's 362ms) - a coin flip decided by relative work duration, not
by which worker actually should have won. No exception was thrown, no
constraint was violated, no log line anywhere says "error." That is exactly
why this class of bug is dangerous: it is silent.

## Fix it

There is no fix that prevents the lock from expiring while a worker is
still working - a TTL is a timeout, and no timeout can distinguish "the
holder is dead" from "the holder is just slow" (see the network-partition
discussion in Production Notes). The fix has two complementary layers:

**Primary fix - fencing tokens** (`src/redis-lock/fencing-token.ts`): every
successful lock acquisition also atomically hands out a strictly-increasing
number via `INCR` on a separate counter key. Workers must carry that token
into their write, and the write path becomes a conditional `UPDATE
resource_state SET fencing_token = $1, ... WHERE name = $2 AND fencing_token
< $1` - the exact conditional-write pattern Lab 11 teaches, just using a
lock-issued token instead of an app-managed version column. Replaying the
identical interleaving as the bug above:

```json
{"workerId":"worker-A","fencingToken":1,"writeRowCount":0,"writeAccepted":false}
{"workerId":"worker-B","fencingToken":2,"writeRowCount":1,"writeAccepted":true}
{"finalRow":{"fencingToken":2,"lastWriter":"worker-B"}}
```

Worker A's lock still expired. Worker B still acquired the "same" lock.
Worker A still has no idea anything went wrong. But A's write, carrying the
older token `1`, hits `WHERE fencing_token < 1` against a row whose
`fencing_token` is already `2` - the condition is false, `rowCount = 0`, the
write is a silent no-op from Postgres's point of view (silent to A, but a
real, observable `rowCount: 0` to anyone checking). The correct worker's
write - whichever one actually got the higher token - always wins,
regardless of which one happened to finish last.

**Complementary mitigation - lease renewal** (`src/redis-lock/lease-
renewal.ts`): for genuinely long-running work, a heartbeat that renews
(extends) the lease's TTL periodically, well before it would expire, means
a holder that is really still alive and working never loses its lock in the
first place - see the "successful renewal" run below, where a lock survives
1000ms of work under a 200ms TTL because it renews every 60ms. This is
strictly best-effort: if the holder's process cannot run its renewal loop
for longer than the TTL (a long GC pause, a suspended container, a blocked
event loop), the lease still expires exactly as in the bug above - the
"renewal pause" run below shows a competitor stealing the lock after a
500ms pause against a 200ms TTL, and the paused holder's own later renewal
attempt correctly failing once it wakes up. This is precisely why fencing
tokens exist as a second, independent layer: they protect the downstream
write even in the exact case renewal cannot prevent.

## Why the fix works

`INCR` on the fencing counter key is atomic and monotonic in Redis
regardless of how many callers believe they concurrently hold the
associated lock - even under the exact double-acquisition bug this lab
reproduces, two different callers calling `INCR` always receive two
different, ordered values. The fencing token is therefore a reliable proxy
for "acquisition order," even when the lock itself failed to provide mutual
exclusion. Handing that token to Postgres and enforcing `fencing_token <
$1` moves the actual guarantee into the datastore that is authoritative for
the resource being protected - the same "keep guarantees close to the data"
principle Lab 11's conditional writes and Lab 15's idempotency keys apply.
The lock's job shrinks to "reduce how often two workers do redundant work
concurrently" (a performance/efficiency concern); the fencing token's job is
"guarantee correctness of the persisted result regardless of what the lock
does" (a correctness concern). Separating those two concerns is the whole
lesson.

Lease renewal works for the ordinary case because Redis's `PEXPIRE`,
guarded by the same atomic token-check Lua script as release, only extends
a lease the caller still actually owns - a renewal call from a holder that
has already lost the lock (because it was too slow to renew, ever) correctly
fails rather than "stealing back" a key someone else may now legitimately
own.

## Tradeoffs

- **Redis lock+fencing vs. a Postgres transaction**: if the resource being
  protected already lives in Postgres and the "critical section" is a
  single unit of work you can express as one transaction, just use a
  transaction (or `SELECT ... FOR UPDATE`, Lab 10) - it is simpler, has one
  fewer moving part (no separate Redis dependency), and Postgres's MVCC
  already gives you the atomicity for free. Reach for Redis coordination
  when the critical section spans multiple systems, needs to be held across
  multiple round trips or a long external operation, or needs lock
  granularity/throughput characteristics Postgres row locks don't fit well
  (e.g. very high-frequency try-lock/skip patterns across many keys that
  don't map cleanly to rows).
- **Redis lock+fencing vs. a conditional write / unique constraint**: if the
  actual invariant is "at most one row may exist/transition into this
  state," a unique constraint or `UPDATE ... WHERE version = ?` (Lab 11)
  enforces it directly and unconditionally for every writer - a Redis lock
  only coordinates writers who choose to check it (the exact limitation
  Lab 13 demonstrates for advisory locks). This lab's own fencing-token fix
  is itself an admission of this: the actual correctness guarantee lives in
  Postgres's conditional `UPDATE`, not in Redis.
- **Redis lock+fencing vs. a Postgres advisory lock (Lab 13)**: if every
  coordinating process already talks to the same Postgres instance, an
  advisory lock gives you the same "one worker at a time" coordination
  without adding Redis as a dependency at all, and ties lock lifetime to a
  connection/transaction Postgres already manages for you. Reach for Redis
  instead when coordination must happen across processes/services that
  don't (or shouldn't) all hold a Postgres connection for the duration, or
  when you need TTL-based expiration semantics Postgres advisory locks
  don't have (an advisory lock has no built-in expiry - it lives until
  explicitly released or the connection dies).
- **Fencing tokens vs. lease renewal**: renewal tries to prevent the expiry
  from happening at all, which is cheaper when it works (no extra column,
  no conditional-write plumbing) but has an irreducible best-effort gap
  (anything that stops the process from running its renewal loop). Fencing
  tokens accept that expiry can happen and defend the downstream resource
  instead, which costs a schema column and a conditional-write code path
  but has no equivalent gap - it works even when renewal fails, precisely
  because it makes no assumption about the lock holder's liveness at all.
  Production systems commonly use both: renewal to reduce how often the bug
  scenario actually occurs, fencing tokens to guarantee correctness on the
  occasions it still does.

## Production notes

1. **What guarantee does this mechanism give?** `SET NX PX` guarantees at
   most one caller can hold a given key's value at a time, for as long as
   the TTL has not elapsed and no one calls the correct atomic release.
   Fencing tokens additionally guarantee that, among any set of writes
   carrying a token, only the write with the highest token a resource has
   seen so far is ever accepted - regardless of how many "holders" the lock
   itself allowed.
2. **What does it not guarantee?** The lock does not guarantee the holder
   is still alive, still fast enough, or still has the lock by the time it
   finishes work - TTL expiry is a timeout, not a liveness check. The lock
   alone also does not protect any downstream row the way a unique
   constraint or conditional write does; a caller that bypasses the lock
   (or a fencing-unaware write path) is just as unprotected as in Lab 13's
   advisory-lock row-protection demonstration.
3. **What breaks under process crash?** A crashed holder's lock simply
   expires at the TTL - no different, from Redis's point of view, than a
   holder that is merely slow. This is exactly the ambiguity fencing tokens
   are designed around: Redis (or any lock manager) cannot tell "crashed"
   apart from "network-partitioned but still running and about to write."
4. **What breaks under network partition?** This is the classic "the lock
   holder is not dead, just slow/partitioned" problem, and no lock manager
   fully solves it: a holder that is cut off from Redis (or from the
   downstream resource) by a partition may still be alive, may still
   believe it holds the lock (its local clock hasn't hit the TTL from its
   own point of view, or it simply hasn't checked), and may still complete
   its "critical section" and issue a write the instant the partition
   heals - arriving well after a second, un-partitioned worker has already
   acquired the lock and written. A fencing token defends exactly this
   case: the partitioned worker's write still carries its old, now-stale
   token, and the downstream conditional `UPDATE` still rejects it,
   regardless of how long the partition lasted or when it healed. No amount
   of "make the TTL longer" or "add a distributed consensus layer for the
   lock itself" removes this ambiguity at the lock layer - the fix has to
   live at the point where the write is actually applied.
5. **What changes at high contention?** Many workers racing `SET NX PX` on
   the same key produces many fast, cheap failures (an immediate `nil`
   response, no queueing, no blocking) - very different from a Postgres row
   lock, which queues waiters. This makes Redis locks a reasonable fit for
   "try once, skip if busy" workloads, but a poor fit for "must eventually
   acquire" workloads unless the caller adds its own retry/backoff loop.
6. **What changes with multiple regions?** A single Redis instance (or even
   a single-region Redis Cluster) is a single point of coordination -
   cross-region workers coordinating through it pay real round-trip latency
   per acquisition and share fate with that Redis's availability. Multi-
   region distributed locking (e.g. Redlock-style multi-instance quorum
   schemes) trades that single point of failure for materially higher
   complexity and its own well-documented correctness debates - most
   systems are better served by keeping the authoritative write (and its
   fencing check) in one region's datastore and treating the lock purely as
   a latency/throughput optimization, not a correctness boundary.
7. **What metrics would you monitor?** Lock acquisition latency and
   failure/contention rate, TTL-expiry-without-explicit-release count
   (a proxy for how often the bug scenario is actually happening in
   production), fencing-token rejection rate (`rowCount = 0` on the
   conditional write - every rejection is a real prevented corruption, and
   a rising rate means your TTL or renewal cadence is miscalibrated
   relative to real work durations), and renewal-loop heartbeat gaps
   (how close any single renewal interval came to the TTL, as an early
   warning that a GC pause or scheduling delay is eating into your safety
   margin).
8. **What simpler alternative could be used?** If the invariant can be
   expressed as a single-row conditional write, a unique constraint, or a
   single transaction against one Postgres instance, use that directly -
   per CLAUDE.md's "Distributed Locks" section and `docs/architecture-
   principles.md`, prefer datastore-native guarantees before introducing
   external coordination. Use a Postgres advisory lock (Lab 13) instead of
   Redis when every coordinating process is already a Postgres client and
   you don't need TTL-based expiry.
9. **When should you avoid this technique?** Avoid a bare Redis lock (no
   fencing token, no renewal) for anything where the "work" duration is
   variable, externally dependent (a downstream HTTP call, a slow query), or
   not tightly bounded - that variability is exactly the gap this lab's bug
   exploits. Avoid distributed locking entirely when the invariant can be
   pushed into the datastore that's already authoritative for the data being
   protected; adding Redis coordination on top of a Postgres write path that
   could already enforce the invariant directly is pure incidental
   complexity.

## Interview questions

1. Why must `NX` and `PX` be part of the same `SET` command rather than two
   separate `SETNX` and `EXPIRE` calls?
2. A lock's release function does `GET` then `DEL` as two separate Redis
   commands. Describe a concrete interleaving that makes this unsafe, and
   explain why wrapping both in a single Lua script fixes it.
3. A lock's TTL expires while its holder is still doing legitimate work.
   Whose fault is that, and what change to the TTL value would fully solve
   it?
4. Explain, precisely, what a fencing token protects against that a longer
   TTL cannot.
5. Why is `INCR` on a Redis counter key still reliably monotonic even when
   two callers both (wrongly) believe they hold the same lock at the same
   time?
6. When would a Postgres advisory lock (Lab 13) be a better fit than a
   Redis-based lock for the same coordination problem, and when would it
   not be?
7. A holder renews its lease every 100ms against a 500ms TTL, but a GC
   pause stops its process for 2 seconds. Walk through exactly what
   happens to the lock, to a competing worker, and to the original holder's
   next renewal attempt once it resumes.
8. Why can't any lock manager - Redis, Postgres advisory locks, or
   otherwise - fully distinguish "the holder crashed" from "the holder is
   alive but network-partitioned"? What design choice compensates for that
   ambiguity in this lab's fix?

## Further experiments

- In `src/redis-lock/lease-expiry-bug.ts`, lower `WORKER_B_START_DELAY_MS`
  below `LOCK_TTL_MS` and rerun `pnpm scenario:lease-expiry-bug` - confirm
  worker B's acquisition now fails (`lockAcquired: false`), since A's TTL
  genuinely has not elapsed yet. This is the "working as intended" case the
  bug scenario deliberately avoids.
- In `src/redis-lock/fencing-token.ts`, swap which worker starts first (or
  add a third worker) and confirm the write that lands correctly is always
  the one with the highest fencing token, regardless of arrival order in
  Postgres.
- Add a real network partition simulation: wrap one worker's Redis calls in
  an artificial multi-second delay (a fake partition) after it has already
  acquired the lock and fetched its fencing token, then let it "heal" and
  attempt its write after a second worker has already acquired and written.
  Confirm the partitioned worker's write is still rejected by its stale
  token, exactly as the Production Notes' network-partition discussion
  predicts.
- In `src/redis-lock/lease-renewal.ts`, set `renewIntervalMs` larger than
  `ttlMs` in `demonstrateSuccessfulRenewal`'s call and confirm the
  "successful" renewal demo starts behaving like the pause demo - a renewal
  cadence slower than the TTL is functionally the same failure mode as a
  paused renewal loop.
- Watch `redis-cli -p 6422 MONITOR` while running `pnpm scenario:lease-
  renewal` and count the real `PEXPIRE` calls against the logged
  `renewalCount` to confirm they match exactly.

## Real validation run (captured output)

The following are actual values captured from a real run against this lab's
Docker Compose stack (not hypothetical/aspirational output).

**`pnpm seed` (fresh volume):**

```json
{"scenarioResources":[{"id":1,"name":"Scenario Resource - Lease Expiry Bug"},{"id":2,"name":"Scenario Resource - Fencing Token Fix"}]}
{"seed":42,"size":"small","scenarioResources":2,"browsingResources":5}
```

**`pnpm scenario:basic-lock`:**

```json
{"key":"lock:demo:basic-lock-race","tokenA":"56d4adec-fdbb-4ad9-ba93-59b74db8a331","tokenB":"476103ac-c251-4907-96ba-366694932234","acquiredA":true,"acquiredB":false,"winner":"A"}
{"key":"lock:demo:wrong-owner-release","realOwnerToken":"652c7791-328e-4e47-99a6-784080943962","wrongToken":"706dc69e-2383-41ff-a2b6-d36eac61905f","wrongOwnerReleaseSucceeded":false,"keySurvived":true,"keyValueAfter":"652c7791-328e-4e47-99a6-784080943962"}
{"key":"lock:demo:unsafe-get-then-del","tokenA":"d63b46f7-dd50-40af-8995-01adc118b545","tokenB":"c4ff0974-6f68-48a9-bb51-59c8df619a1d","acquiredBAfterExpiry":true,"aDeletedBsLock":true,"keyValueAfterAsRelease":null}
```

Exactly one of two concurrent `SET NX PX` calls on the same key succeeded. A
worker with the wrong token could not release the real owner's lock, and the
key survived untouched with the real owner's token still in place. The
naive GET-then-DEL release genuinely deleted a *different* owner's key
after that owner acquired it during the unguarded gap between the naive
function's two calls.

**`pnpm scenario:lease-expiry-bug`:**

```json
{"workerId":"worker-A","lockAcquired":true,"lockAcquiredAtMs":0,"workStartedAtMs":1,"workEndedAtMs":401,"writeAttemptedAtMs":401,"writeRowCount":1}
{"workerId":"worker-B","lockAcquired":true,"lockAcquiredAtMs":261,"workStartedAtMs":261,"workEndedAtMs":362,"writeAttemptedAtMs":362,"writeRowCount":1}
{"bothBelievedTheyHeldTheLockAtTheSameTime":true}
{"finalRow":{"id":"8","fencingToken":0,"lastWriter":"worker-A","updatedAt":"2026-08-19T10:31:36.685Z"}}
```

Worker A acquired its lock at `t=0ms` with a 200ms TTL and did not renew.
Worker B acquired the SAME key at `t=261ms` - well past the 200ms TTL - and
genuinely succeeded (`lockAcquired: true`), proving A's lease had really
expired in Redis. Both workers wrote to `resource_state` (`writeRowCount: 1`
each, no errors). B's acquisition (`261ms`) happened before A's write
(`401ms`) - real, provable overlap: both workers believed, at the same
moment in wall-clock time, that they alone held the lock. The final row
shows `lastWriter: "worker-A"` purely because A's write landed
chronologically last.

**`pnpm scenario:fencing-token`** (identical interleaving, fencing tokens added):

```json
{"workerId":"worker-A","lockAcquired":true,"fencingToken":1}
{"workerId":"worker-B","lockAcquired":true,"fencingToken":2}
{"workerId":"worker-B","fencingToken":2,"writeRowCount":1,"writeAttemptedAtMs":355}
{"workerId":"worker-A","fencingToken":1,"writeRowCount":0,"writeAttemptedAtMs":410}
{"staleWriteRejected":true,"newerWriteAccepted":true}
{"finalRow":{"id":"9","fencingToken":2,"lastWriter":"worker-B"}}
```

The lock-expiry bug still happened exactly as before (both `lockAcquired:
true`). Worker A got fencing token `1`, worker B got the strictly higher
token `2`. Worker B's write (token `2`, arriving at `355ms`) was accepted
(`rowCount: 1`). Worker A's write (token `1`, arriving later at `410ms`)
was rejected outright (`rowCount: 0`) by the conditional `UPDATE ... WHERE
fencing_token < $1` - even though worker A's own code never found out its
lease had expired and believed its write should succeed. The final row
correctly reflects worker B, the holder with the higher (newer) token,
regardless of arrival order.

**`pnpm scenario:lease-renewal`:**

```json
{"ttlMs":200,"renewIntervalMs":60,"workDurationMs":1000,"renewalCount":16,"lockHeldThroughout":true,"competitorAcquiredDuringWork":false}
{"ttlMs":200,"pauseMs":500,"lockStolenDuringPause":true,"renewalAfterPauseSucceeded":false}
```

A holder renewing every 60ms against a 200ms TTL survived 1000ms of work
(16 real renewals) with no competitor ever able to acquire the lock. A
holder that instead "paused" for 500ms (longer than the 200ms TTL) had its
lock genuinely stolen by a competitor, and its own later renewal attempt
correctly failed once it "woke up" - proving renewal is a real, working
mitigation for the ordinary case, and an honestly best-effort one for the
pause case fencing tokens exist to cover.

`pnpm test` (4 test files, 7 tests) and `pnpm typecheck` both pass cleanly
against this output. The full `docker compose down -v && docker compose up
-d && pnpm db:migrate && pnpm seed && pnpm test` reset flow was also run
from a clean volume and produced the same passing results (with fresh
resource ids, since the identity sequence restarts along with the dropped
volume, and fresh fencing-token values starting from `1` again since Redis
itself was recreated).
