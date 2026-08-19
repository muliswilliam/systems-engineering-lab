# Lab 36 - Rate Limiting and Backpressure

## Why this exists

Every earlier concurrency lab in this repository protects an invariant that
lives inside a request: a balance, a seat, a job's status. This lab protects
something different - the SERVICE itself. Two related but distinct failure
modes overload a backend: too many requests arriving (a client, or a burst of
clients, sending more traffic than the service is willing to accept) and too
much work in flight or queued at once (a downstream dependency, or the
service's own capacity, falling behind the rate work arrives at, with no
signal to slow down). Rate limiting fixes the first. Backpressure fixes the
second. They are complementary, not interchangeable, and a system with
plenty of headroom on one can still be brought down by the other - this lab
proves both problems and both fixes with real, measured numbers, then proves
the distinction itself with a scenario where the rate limiter has room to
spare and the service still falls over.

This lab is framed at the APPLICATION layer, not the database-connection
layer: Lab 23 (connection-management-and-pgbouncer) already covers Postgres
connection-pool exhaustion in depth, with its own real captured
`SQLSTATE 53300` rejections. Nothing here re-derives that - the "unprotected"
baseline in this lab is a generic, in-process, capacity-limited resource
standing in for any slow downstream (a payment gateway, a search backend, a
third-party API), not Postgres itself.

## Learning objectives

After this lab you should be able to:

- explain concretely why an API with no limit on concurrent in-flight calls
  to a slow, finite-capacity downstream produces real timeouts once
  concurrency exceeds what that downstream can serve within a reasonable
  wait - and reproduce that failure with a real measured failure count, not
  a description of it;
- implement token bucket AND sliding window log rate limiting against a real
  Redis-backed atomic counter, and explain precisely why the check-and-admit
  step must be atomic (a Lua script) rather than separate read/check/write
  Redis commands;
- state the concrete tradeoff between the two algorithms: token bucket
  allows a controlled burst up to its capacity and then throttles to a
  steady refill rate; sliding window log enforces an exact, boundary-free
  cap over a moving window at the cost of O(log n) per-request bookkeeping
  instead of a fixed window counter's O(1) (and can explain why a naive
  fixed window counter can let ~2x its limit through across a reset
  boundary);
- implement a real, datastore-backed bounded queue (reusing Lab 14's
  `SELECT ... FOR UPDATE SKIP LOCKED` claiming pattern for consumption) whose
  CAPACITY invariant is enforced by a Postgres conditional `UPDATE` - the
  same conditional-write idiom Lab 11 teaches - rather than by
  application-level counting or an external lock;
- state precisely why rate limiting and backpressure are not substitutes for
  each other, backed by a real measured scenario where a rate limiter
  rejects zero requests and the service still produces real downstream
  timeouts.

## Architecture

```text
                 ┌─────────────────────────┐
  request  ───►  │  rate limiter (Redis)   │  ──► REJECT (too many REQUESTS)
                 │  token bucket /         │
                 │  sliding window         │
                 └───────────┬─────────────┘
                             │ admitted
                             ▼
                 ┌─────────────────────────┐
                 │  bounded queue /        │  ──► REJECT (too much IN-FLIGHT/QUEUED WORK)
                 │  concurrency limiter    │
                 │  (Postgres: queue_state │
                 │   + jobs, SKIP LOCKED)  │
                 └───────────┬─────────────┘
                             │ accepted
                             ▼
                 ┌─────────────────────────┐
                 │  slow downstream        │  (real, in-process, bounded-capacity
                 │  (BoundedResource)      │   simulation - a stand-in for a
                 └─────────────────────────┘   payment gateway / search backend)
```

This lab is about a generic "protect the service" mechanism, not a rich
business domain - so, unlike most labs in this repository, its schema models
the mechanism directly rather than a payroll/ticketing/commerce/banking/
background-processing domain:

- `jobs` - the backpressure-protected work queue. Reuses the shape and
  `FOR UPDATE SKIP LOCKED` claiming pattern Lab 14
  (job-queue-skip-locked) established for consumption, but deliberately
  does NOT re-derive Lab 14's retry/lease/crash-recovery machinery (no
  `attempts`/`locked_until` columns) - this lab's own subject is capacity,
  not retry semantics.
- `queue_state` - a single row (`id = 1`) holding the queue's `capacity` and
  current `pending_count`. The capacity invariant (`pending_count` never
  exceeds `capacity`) is enforced entirely inside PostgreSQL via a
  conditional `UPDATE ... WHERE pending_count < capacity` - the same
  conditional-write idiom Lab 11 teaches, applied here to a capacity gate
  instead of a version column - per CLAUDE.md's "prefer datastore-native
  guarantees" principle, rather than counting in application memory (only
  correct for one process) or reaching for a Redis lock.
- `rate_limit_events` - a plain observability log of every rate-limiter
  decision, purely so PGweb has something real to show for the
  rate-limiting half of this lab. The limiter's actual state (token counts,
  the sliding window's request log) lives in Redis, not here - this table
  never gates any decision.

Why Redis for rate limiting and Postgres for the queue, together in one
lab (the port-convention hint that led here): the two mechanisms have
different natural homes. A rate limiter's hot path is a tiny, extremely
high-frequency counter check with no need for durability beyond the current
window - exactly what Redis (an in-memory store with atomic Lua scripting)
is for. The bounded queue's hot path is "hand out work to a worker exactly
once and never lose it," which is precisely PostgreSQL's `SKIP LOCKED`
job-queue pattern - the same guarantee Lab 14 already teaches. Neither
mechanism is forced into the other's role: this lab does not implement rate
limiting in Postgres, and it does not implement the bounded job queue in
Redis (see "Tradeoffs" for the specific reasons a Redis-backed queue would
be a worse fit here).

`src/downstream/slow-downstream.ts`'s `BoundedResource` is this lab's one
other piece of infrastructure - a real, in-process, FIFO-queued,
timeout-enforcing semaphore standing in for "a fixed-size pool of
connections to a slow downstream." It is intentionally not a Postgres
connection pool (see "Why this exists" above).

No `--size`/`--rows` seed flags - this lab has no bulk realistic dataset;
every scenario generates its own load at run time.

## Setup

```bash
pnpm install
cp labs/36-rate-limiting-and-backpressure/.env.example labs/36-rate-limiting-and-backpressure/.env
cd labs/36-rate-limiting-and-backpressure
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate
pnpm seed
```

Open PGweb at http://localhost:8436 (auto-connects via
`PGWEB_DATABASE_URL`). Redis is reachable at `localhost:6436`
(`docker compose exec redis redis-cli ping` should return `PONG`).

## Scenario

A service exposes an endpoint that, on every request, calls a slow
downstream dependency (payment gateway, search backend, third-party API -
the specifics don't matter, only that it is slow and has real, finite
capacity). Two independent things can overload this service:

1. **Too many requests.** A client (or a bug, or an attacker) sends far more
   requests than the service intends to accept from any one caller.
2. **Too much in-flight/queued work.** Even a modest, well-behaved request
   rate can still overwhelm the service if each request is slow enough and
   nothing bounds how much work can be in flight or queued at once.

The invariant this lab is about:

> A service should reject or delay work it cannot handle, with a fast,
> explicit signal - not silently accept everything and let real requests
> time out, or let an in-memory backlog grow without limit.

## Prediction

Before running anything, predict:

1. If 200 concurrent requests hit an endpoint with NO rate limit and NO
   concurrency limit, and it forwards every one of them directly to a
   downstream that can only truly serve 10 at a time, how many of those 200
   do you expect to succeed?
2. A Redis-backed sliding window rate limiter is configured for 100
   requests/second. 120 concurrent requests arrive within a few
   milliseconds of each other. How many should be allowed? Would a NAIVE
   fixed-window counter (reset every 1000ms on a wall-clock boundary,
   rather than a continuously-moving window) necessarily give the same
   answer if the burst happened to straddle a reset boundary?
3. A bounded, Postgres-backed queue has capacity 20 and is currently empty.
   200 concurrent submissions arrive before any worker has claimed a single
   one. How many should be accepted?
4. A rate limiter allows 50 requests/second, and only 20 requests actually
   arrive - well under that limit. Each request calls a downstream with
   only 3 concurrent slots and 800ms of latency per call. Will the rate
   limiter's headroom prevent overload here? Why or why not?

## Exercise

1. Run the setup commands above.
2. Run the naive, unprotected baseline and compare against the real captured
   numbers in "Break it" below:
   ```bash
   pnpm scenario:naive-overload
   ```
3. Run the rate-limiting fixes and compare against "Fix it":
   ```bash
   pnpm scenario:rate-limit-token-bucket
   pnpm scenario:rate-limit-sliding-window
   ```
4. Run the backpressure fix and its naive counterpart:
   ```bash
   pnpm scenario:backpressure-naive
   pnpm scenario:backpressure-bounded
   ```
5. Run the scenario that isolates the distinction between the two
   mechanisms:
   ```bash
   pnpm scenario:rate-limit-insufficient
   ```
6. Run `pnpm test` and read through each test file - every scenario above
   has a corresponding fast, deterministic invariant test.

## Observe

- **PGweb** (http://localhost:8436): `rate_limit_events` fills up with one
  row per rate-limiter decision after the rate-limiting scenarios;
  `queue_state`'s single row and `jobs`' status column change live while the
  backpressure scenarios run.
- **Structured logs**: every scenario logs through `@labs/logging` (Pino)
  with exact counts (`allowed`/`rejected`/`succeeded`/`failed`/
  `maxObservedPendingCount`) as real fields, not prose.
- **`redis-cli -p 6436 monitor`** while a rate-limiting scenario runs - watch
  the atomic Lua script's underlying `HMGET`/`HMSET`/`EXPIRE` (token bucket)
  or `ZREMRANGEBYSCORE`/`ZCARD`/`ZADD`/`PEXPIRE` (sliding window) commands.
- **`process.memoryUsage()`**, logged directly by
  `scenario:backpressure-naive` - real heap growth, not a description of it.

## Break it

Run:

```bash
pnpm scenario:naive-overload
```

Real captured output from this lab's own validation run (downstream
capacity 10, 250ms latency, 1000ms acquire timeout, 200 concurrent
requests, no rate limit, no concurrency limit):

```text
starting naive overload burst (no rate limit, no backpressure)
  downstreamCapacity: 10   downstreamLatencyMs: 250   acquireTimeoutMs: 1000   concurrentRequests: 200
OVERLOAD CONFIRMED: real acquire-timeout errors occurred because more requests arrived than the downstream could ever serve within its own timeout budget
  concurrentRequests: 200   succeeded: 40   failed: 160   theoreticalMaxServedWithinTimeout: 40   elapsedMs: 1006
example of a real captured failure
  sampleError: "Error: downstream acquire timed out after 1000ms - the resource pool (capacity 10) has been exhausted for the entire wait"
```

160 of 200 requests received a real `Error` - not a slow response, an actual
failure - because the downstream can serve at most `10 slots * (1000ms /
250ms per call) = 40` requests within its own timeout budget, and 200
requests arrived at once with nothing limiting how many were allowed to even
try. `tests/integration/naive-overload.test.ts` asserts this as a real
invariant (`failed > 0` at 100 concurrent requests against a
capacity-5/100ms/300ms downstream, contrasted against `0` failures when
concurrency is bounded to the downstream's own capacity).

## Fix it

**Fix #1 - rate limiting** (protects against too many REQUESTS):

```bash
pnpm scenario:rate-limit-token-bucket
pnpm scenario:rate-limit-sliding-window
```

Real captured output, token bucket (capacity 100, refill 100/sec, 120
concurrent requests fired essentially simultaneously):

```text
starting token-bucket burst
  capacity: 100   refillPerSecond: 100   burstSize: 120
RATE LIMIT ENFORCED EXACTLY: allowed count matches bucket capacity, no more, no less
  burstSize: 120   capacity: 100   allowed: 100   rejected: 20   elapsedMs: 5
```

Real captured output, sliding window (window 1000ms, limit 100, same 120
concurrent burst - the exact "120 requests in 1 second against a 100/sec
limit" scenario):

```text
starting sliding-window burst
  windowMs: 1000   limit: 100   burstSize: 120
RATE LIMIT ENFORCED EXACTLY: allowed count matches the configured limit, no more, no less
  burstSize: 120   limit: 100   windowMs: 1000   allowed: 100   rejected: 20   elapsedMs: 5
```

Both algorithms produced the exact same split (100 allowed, 20 rejected) in
5ms - not an approximation, and not from timing luck: the exactness comes
from each Lua script's atomicity (see "Why the fix works"). Rerun either
scenario repeatedly - the split is 100/20 every time, because `pnpm seed`
flushes Redis and each scenario uses a key namespaced to its own algorithm.
`tests/integration/token-bucket.test.ts` and
`tests/integration/sliding-window.test.ts` assert this exactly, plus each
algorithm's own refill/window-expiry behavior using fixed, explicit
timestamps rather than real sleeps (per CLAUDE.md's "avoid fragile timing
assertions" guidance).

**Fix #2 - backpressure** (protects against too much IN-FLIGHT/QUEUED
WORK):

```bash
pnpm scenario:backpressure-naive
pnpm scenario:backpressure-bounded
```

Real captured output, the naive unbounded in-process queue (5,000 tasks,
each carrying a genuinely distinct 5KB random payload so memory growth is
real and not deduplicatable, pushed in a tight burst against a single
consumer processing one task every 5ms):

```text
submitting a burst of tasks with no capacity check at all
  taskCount: 5000   payloadRandomBytes: 2500   consumerPerTaskMs: 5
UNBOUNDED GROWTH: every single submitted task was accepted - nothing rejected it and nothing signaled the producer to slow down
  taskCount: 5000   queueLengthImmediatelyAfterProduction: 5000   heapBeforeMB: 9.15   heapAfterProductionMB: 34.1   heapGrowthMB: 24.95

the backlog barely moved during the observation window - the consumer's fixed per-task latency, not any capacity limit, is the only thing gating drain speed
  stillQueuedAfterObservationWindow: 4643   consumedSoFar: 357   observationWindowMs: 2000
```

A real, measured 24.95MB heap growth for 5,000 tasks * ~5KB each (matching
the ~25MB predicted from the payload size almost exactly), and after a full
2-second observation window the single slow consumer had only processed 357
of the 5,000 tasks - the backlog is still 4,643 deep and nothing in this
code path ever rejects a submission or shrinks it. (An earlier draft of this
scenario used `"x".repeat(n)` for the payload and measured almost no heap
growth at all - see "Architecture" note below on why that was misleading,
not a smaller real effect.)

Real captured output, the bounded, Postgres-backed queue (capacity 20):

```text
Phase 1: saturating an idle queue
  capacity: 20   burstSize: 200
BACKPRESSURE ENFORCED EXACTLY: accepted count matches queue capacity, no more, no less
  burstSize: 200   capacity: 20   accepted: 20   rejected: 180

Phase 2: draining with one worker while a producer keeps submitting faster than it can keep up
  capacity: 20   workerWorkMs: 30   durationMs: 2000
INVARIANT HELD under sustained pressure: pending_count never exceeded capacity across every sample taken
  durationMs: 2000   capacity: 20   phase2Accepted: 62   phase2Rejected: 3016   processedByWorker: 82   maxObservedPendingCount: 20   pendingCountSampleCount: 79
```

Phase 1: exactly 20 of 200 concurrent enqueue attempts against an idle
queue were accepted - a real, exact enforcement of the capacity bound, the
same atomicity argument as the rate limiters but enforced by a Postgres row
lock (the conditional `UPDATE`) instead of a Redis Lua script. Phase 2:
under 2 seconds of continuous submission pressure with one worker draining
at 30ms/job, `pending_count` was sampled 79 times and never once exceeded
20 - not "usually stayed near 20," never exceeded it - while 62 of 3,078
attempts were accepted and the rest received an immediate, cheap rejection
rather than being queued indefinitely.
`tests/integration/bounded-queue.test.ts` asserts both invariants directly
against the database.

**The distinction** (rate limiting alone is not enough):

```bash
pnpm scenario:rate-limit-insufficient
```

Real captured output (rate limit 50/sec - generous headroom; only 20
requests sent; downstream capacity 3, 800ms latency, 500ms acquire
timeout):

```text
starting rate-limit-insufficient demo: requests stay well under the rate limit but still overload a slow, low-concurrency downstream
  rateLimit: 50   rateLimitWindowMs: 1000   downstreamCapacity: 3   downstreamLatencyMs: 800   acquireTimeoutMs: 500   requestCount: 20
CONFIRMED: zero requests were rejected by the rate limiter (plenty of headroom), yet real downstream timeouts occurred - rate limiting alone did not prevent overload
  requestCount: 20   rateLimit: 50   rateLimited: 0   downstreamTimedOut: 17   succeeded: 3
```

Zero of the 20 requests were rejected by the rate limiter (20 is well under
its 50/sec budget) - and yet 17 of those 20 admitted requests still failed
with a real downstream timeout, because nothing bounded how many of them
could pile into the slow, 3-slot-capacity downstream at once. The rate
limiter did exactly what it promises (control the rate of incoming
requests) and that promise, alone, was never going to prevent this failure
mode.

## Why the fix works

**Token bucket and sliding window (rate limiting).** Both algorithms'
correctness depends entirely on their check-and-admit step being atomic.
A naive implementation issuing separate Redis commands ("read the counter,
compare to the limit, write the updated counter back") has a check-then-act
race: two concurrent callers can both read "under the limit," both decide to
admit, and both write - letting the limit be exceeded under real
concurrency. Each limiter here instead runs a single Lua script, which Redis
executes to completion with no other command interleaved - the same
"protect the invariant with a single indivisible operation" principle Lab
11's `UPDATE ... WHERE version = ?` uses at the Postgres row level, applied
here to a Redis-resident counter. Token bucket additionally computes refill
lazily from elapsed wall-clock time on each call rather than a background
timer, so it needs no scheduled job to stay correct. Sliding window log
trims expired entries and counts remaining ones in the same atomic step, so
its limit is exact across any instant in time, not just at fixed reset
boundaries.

**Bounded, Postgres-backed queue (backpressure).** The capacity invariant is
enforced by `UPDATE queue_state SET pending_count = pending_count + 1 WHERE
pending_count < capacity` - a conditional write whose `WHERE` clause is
checked against the row's current, lock-protected value. Postgres takes a
row lock on `queue_state`'s single row for the duration of this statement,
so concurrent `enqueue` calls are serialized through it: only as many can
succeed as there is remaining capacity, no matter how many arrive at the
exact same instant. This is the identical mechanism Lab 11 teaches
(conditional writes as an alternative to a background lock), applied here to
a capacity gate rather than an optimistic-concurrency version column.
Consumption reuses Lab 14's `SELECT ... FOR UPDATE SKIP LOCKED` claiming
pattern unchanged, so two workers never claim the same job.

## Tradeoffs

- **Token bucket vs. sliding window log.** Token bucket allows a controlled
  burst up to its capacity and then throttles smoothly to the steady refill
  rate - a good fit for "occasional bursts are fine, sustained abuse is
  not." Sliding window log gives an exact, boundary-free cap with no burst
  allowance beyond the limit itself, at the cost of O(log n) work per
  request (a sorted-set trim) instead of token bucket's O(1) hash read/
  write. Neither is implemented here as a NAIVE fixed window counter (a
  single `INCR` + `EXPIRE`) - that approach is the cheapest of the three but
  can let up to ~2x its configured limit through across a window-reset
  boundary, which this lab's own README explicitly does not want to
  present as safe by omission; see `playground/notes.md` for an exercise
  reproducing that exact boundary problem.
- **Redis rate limiting is not itself durable or authoritative for
  anything beyond the current window.** If Redis is unreachable, the
  service must decide explicitly whether to fail open (accept everything -
  risking overload) or fail closed (reject everything - risking
  unnecessary unavailability); neither choice is free, and this lab does
  not implement either, per CLAUDE.md's "do not add chaos for its own sake"
  guidance - it is called out here as a real, unresolved operational
  decision.
- **The Postgres-backed bounded queue adds real latency per enqueue** (a
  transaction round-trip) compared to an in-process counter - correct
  precisely because it is real: the capacity check and the job's
  durability are the same atomic operation, so a bounded queue survives an
  application crash right after a successful `enqueue` (the job is
  already committed), which a purely in-memory bounded queue could not.
  A Redis-backed bounded queue (e.g. a capped `LPUSH`/`BRPOP` list) would
  be faster per operation but reintroduces the "is this counter/queue the
  source of truth, or just a fast path in front of one" question CLAUDE.md's
  "cache vs source of truth" principle raises - not a good fit when the
  queued work itself (not just a rate) needs to survive a crash.
- **Rate limiting and backpressure solve different problems and do not
  substitute for each other**, as this lab's own "distinction" scenario
  measured directly: 0 rate-limit rejections and 17 real downstream
  timeouts, from the SAME 20 requests. A production service facing both
  failure modes needs both controls, not either one scaled up.

## Production notes

1. **What guarantee does this mechanism give?** The rate limiters guarantee
   at most N admitted requests per configured window (sliding window: exact;
   token bucket: exact up to its capacity, then rate-limited to the refill
   rate) for a given client key. The bounded queue guarantees `pending_count`
   never exceeds its configured capacity, verified here across 79 real
   samples under sustained concurrent pressure with zero violations.
2. **What does it not guarantee?** Neither mechanism guarantees the
   DOWNSTREAM itself stays healthy - a rate limiter set too generously, or a
   queue capacity set too high relative to real downstream throughput,
   still allows the "rate-limit-insufficient" failure mode this lab
   measured directly (0 rejections, 17 real timeouts). Capacity/limit values
   must be derived from the downstream's actual sustainable throughput, not
   chosen independently of it.
3. **What breaks under process crash?** A crash mid-request under either
   rate limiter simply loses that one decision - the Redis state survives
   (it is a separate process) and the next request is evaluated normally.
   A crash between a bounded-queue `enqueue`'s COMMIT and a worker claiming
   the job leaves the job safely `pending` in Postgres, exactly as Lab 14
   already covers for crash recovery during processing.
4. **What breaks under network partition?** A partition to Redis degrades
   rate limiting to "no limiting" or "reject everything," depending on how
   the application is written to treat a Redis error (see "Tradeoffs" -
   this lab does not implement either choice, but flags it as a real
   decision). A partition to Postgres makes the bounded queue and its
   worker(s) fail closed automatically (no connection, no claims, no new
   accepted jobs) - arguably safer by default than the Redis case, since
   Postgres being the source of truth for the queue means "can't reach it"
   and "can't safely accept work" are the same condition.
5. **What changes at high contention?** Both rate limiters hold their exact
   guarantee at high contention by construction (Lua-script atomicity is
   independent of request volume) - this lab measured the identical 100/20
   split at 120 concurrent requests as it would at a smaller burst. The
   bounded queue's single-row conditional `UPDATE` does serialize concurrent
   `enqueue` calls through one row lock, so very high enqueue concurrency
   against a very small capacity will show queueing at the database level
   even for calls that are ultimately rejected - a real, bounded cost, not
   an unbounded one.
6. **What changes with multiple regions?** Not applicable to this lab's
   single-Redis/single-Postgres setup. A multi-region deployment needs
   either a region-local rate limiter (each region enforces its own,
   smaller effective limit) or a shared, replicated counter store with its
   own consistency tradeoffs - the same "cache vs source of truth" tension
   Lab 21's own production notes raise for Redis more generally.
7. **What metrics would you monitor?** Rate-limiter rejection rate (a
   signal a client is being throttled, intentionally or not), rate-limiter
   check latency (a signal Redis itself is under load), queue
   `pending_count` as a fraction of `capacity` over time (a signal the
   downstream is falling behind, before the queue actually fills), queue
   rejection rate, and the downstream's own real latency/error rate as
   ground truth for whether the configured limits still match reality.
8. **What simpler alternative could be used?** For a single-process
   deployment with no cross-process rate-limiting need, an in-process
   counter is simpler than a Redis-backed one and gives an identical
   guarantee for that one process - the same "coalescing beats a
   distributed lease for a single process" lesson Lab 21 already teaches
   for caching. For backpressure, if the queued work does not need to
   survive a crash and only one process needs the bound, a simple in-process
   bounded array (reject `push` once `length === capacity`) is simpler than
   the full Postgres-backed queue and gives the identical bound for that
   process.
9. **When should you avoid this technique?** Avoid a strict, low rate limit
   on an endpoint whose real risk is downstream overload rather than abusive
   request volume - that calls for backpressure/concurrency limiting
   instead, as this lab's own "distinction" scenario demonstrates directly.
   Avoid the Postgres-backed bounded queue for extremely high-throughput,
   loss-tolerant work (e.g. best-effort metrics) where the durability and
   transactional overhead cost more than the guarantee is worth - an
   in-process or Redis-backed bound is a better fit there.

## Interview questions

1. Why does a naive "GET the counter, compare to the limit, SET the updated
   counter" rate limiter fail under real concurrency, and what specifically
   makes the Lua-script version immune to that failure?
2. Contrast token bucket, sliding window log, and a naive fixed window
   counter. Which one is cheapest to run at very high request volume, and
   which one is most likely to silently let through more than its
   configured limit?
3. Why is the bounded queue's capacity check implemented as a conditional
   `UPDATE` on a single row rather than an application-level in-memory
   counter? What would break under multiple application processes if it
   were the latter?
4. This lab measured a scenario with zero rate-limit rejections and 17 real
   downstream timeouts from the same 20 requests. Design a rate limit AND a
   backpressure control that together would have prevented that specific
   failure, and explain what each one is protecting against.
5. Why does the bounded queue's `enqueue` durably persist a job as part of
   the same transaction that increments `pending_count`, rather than
   incrementing a Redis counter and inserting the job afterward?
6. What would you monitor to tell the difference between "the rate limit is
   too strict" and "the rate limit is fine but backpressure is missing,"
   using only the metrics this lab's own production notes list?
7. If this lab's bounded queue's capacity were set far higher than the
   downstream it feeds could ever sustain, what failure mode would you
   expect to reappear, and why?

## Further experiments

- Implement a naive fixed window counter (a single Redis `INCR` + `EXPIRE`
  per window) and reproduce the classic boundary problem: fire a burst that
  straddles a window-reset instant and measure how much more than the
  configured limit gets through, compared to the sliding window log's exact
  enforcement of the identical limit.
- Lower `ACQUIRE_TIMEOUT_MS` in `run-naive-overload.ts` and watch `failed`
  climb even with the same 200-request burst and the same downstream
  capacity - the timeout budget, not just capacity, determines how much of
  the burst can ever be served.
- In `run-backpressure-bounded.ts`, add a second worker and re-measure
  Phase 2's `phase2Accepted`/`processedByWorker` - does the bound
  (`maxObservedPendingCount <= capacity`) still hold with two workers
  claiming concurrently via `SKIP LOCKED`?
- Combine the rate limiter and the bounded queue into a single pipeline (rate
  limiter first, then bounded queue, then the slow downstream) and replay
  `run-rate-limit-insufficient.ts`'s exact scenario through it - confirm the
  downstream timeouts disappear once backpressure is added, without
  changing the rate limit at all.
- Add a per-client rate-limit key (rather than this lab's single shared
  `demo-client`) and write a test proving one abusive client's burst does
  not consume another client's quota.
