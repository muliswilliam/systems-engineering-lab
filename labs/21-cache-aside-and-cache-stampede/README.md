# Lab 21 - Cache-Aside and Cache Stampede

## Why this exists

Every earlier lab in this repository protects invariants inside PostgreSQL -
constraints, transactions, row locks, conditional writes. This lab introduces
the first piece of infrastructure that sits *in front of* PostgreSQL rather
than inside it: a cache. A product detail page is expensive to compute (a
real one might join pricing rules, inventory, personalization, or run a slow
search); Redis exists to shield the database from repeating that expensive
work for every request. The naive version of "check the cache, on miss ask
the database, then populate the cache" is correct for exactly one request at
a time and badly broken under concurrency: when the key is cold and hundreds
of requests arrive at once, every single one of them misses before any of
them finishes populating the cache, so the "cache" briefly does nothing to
protect the database at all. This is a cache stampede, and this lab
reproduces it for real, with a real measured database-call count, then fixes
it four different ways that each trade off differently.

## Learning objectives

After this lab you should be able to:

- explain precisely why cache-aside's GET/miss/compute/SET sequence, correct
  for one caller, produces one database call per concurrent caller on a cold
  key;
- implement in-process request coalescing (a single in-flight-promise map)
  and explain why it collapses a same-process stampede to exactly one
  database call, and why it does nothing across multiple processes;
- implement a short Redis lease (`SET key value NX PX`) as a refill
  coordination mechanism that works ACROSS processes, and explain what a
  "safe release" (compare-then-delete via an owner token) protects against
  that a plain `DEL` does not;
- implement stale-while-revalidate and explain the concrete latency/
  staleness tradeoff it makes versus a hard TTL;
- explain why jittered TTL is a purely preventive measure against many keys
  expiring in lockstep, and why it does not by itself protect any single hot
  key from a stampede;
- point to real captured numbers - not theoretical descriptions - for the
  size of the stampede and the effect of each of the four mitigations.

## Architecture

```text
products (id, public_id, name, price_cents)
   ^
   | getProductFromDatabase (75ms artificial delay - the "expensive query")
   |
Redis (product:<id> cache keys, lock:product:<id> lease keys)
   ^
   | getProduct(productId)
   |
caller(s)
```

Domain: a deliberately minimal slice of SPEC.md's commerce domain - just
`products` (id, public_id, name, price_cents), no customers/orders/carts.
The point of this lab is cache behavior in front of a slow read, not a rich
product catalog; the same "small standalone-shaped table" reasoning as
Lab 06's `counters`/Lab 11's `documents`/Lab 15's `payments` applies here.
Seeding reuses `@labs/data-generators`'s existing commerce `generateProducts`
(only `name`/`unitPriceCents` are carried over - `sku`/`category` are
dropped since this schema has no columns for them) rather than adding a new
generator.

Five cache implementations, all wrapping the same slow
`getProductFromDatabase` (via `createProductReader`, which also counts real
calls so every scenario/test has a real number, not a description):

```text
src/cache/naive-cache-aside.ts        <- GET/miss/compute/SET, no stampede protection (BROKEN)
src/cache/request-coalescing.ts       <- in-process in-flight-promise map (FIX, in-process only)
src/cache/lease-based-refill.ts       <- Redis SET NX PX lease (FIX, cross-process)
src/cache/stale-while-revalidate.ts   <- serve stale + background refresh (FIX, latency-focused)
src/cache/jittered-ttl.ts             <- TTL +/- jitter (FIX, preventive, many-keys-focused)
```

`src/cache/redis-client.ts` is this lab's own small Redis connection helper
(`createRedisClient`/`waitForRedis`), the Redis-specific counterpart to
`@labs/db-utils`'s `createPool`/`waitForDatabase`. It stays LOCAL to this lab
rather than moving into a shared package - see the doc comment in that file
for the reasoning (no second consumer exists yet; Lab 22 is a natural future
promotion point if it needs the identical helper).

## Setup

```bash
pnpm install
cp labs/21-cache-aside-and-cache-stampede/.env.example labs/21-cache-aside-and-cache-stampede/.env
cd labs/21-cache-aside-and-cache-stampede
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate
pnpm seed --seed=42 --size=small   # 20 products
```

Open PGweb at http://localhost:8421 (auto-connects via
`PGWEB_DATABASE_URL`) - you should see 20 rows in `products`. Redis is
reachable at `localhost:6421` (`docker compose exec redis redis-cli ping`
should return `PONG`).

## Scenario

A product detail page's data is expensive to compute and is cached in Redis
under key `product:<id>` with a TTL. Many browsers can request the exact same
product page within milliseconds of each other - especially right after the
cache entry expires, or right after a deploy/cold start when the cache is
empty. The invariant this lab is about:

> A cold cache key should not cause more concurrent database reads than are
> actually necessary to repopulate it - ideally exactly one, no matter how
> many concurrent callers ask for that key at once.

## Prediction

Before running anything, predict:

1. If 300 concurrent requests for the same product id arrive while the cache
   key is missing, and each request independently does GET/miss/compute/SET
   with no coordination, how many times do you expect the slow database
   function to be called? Once? Around half? All 300?
2. An in-process in-flight-promise map (request coalescing) collapses this to
   exactly one database call. Would it still work if the 300 requests were
   spread across 5 separate Node processes (5 separate API replicas) instead
   of all landing in one process?
3. A Redis lease (`SET lock:<key> <owner> NX PX <ms>`) is acquired by exactly
   one caller system-wide, no matter how many processes are asking. What
   should every OTHER caller do while they wait - retry the database
   themselves, or wait for the lease-holder to finish?
4. Stale-while-revalidate serves a stale cached value immediately instead of
   blocking on the database. What is the concrete cost of this - and does it
   ever fall back to blocking?
5. If 200 cache keys are all populated at the exact same instant with the
   exact same fixed TTL, what happens to all 200 of them a fixed number of
   milliseconds later? Does jittering the TTL protect any ONE of those keys
   from a stampede, or does it protect something else?

## Exercise

1. Run the setup commands above.
2. Run the naive scenario and compare against the real captured numbers in
   "Break it" below:
   ```bash
   pnpm scenario:naive-stampede
   ```
3. Run the four fixes and compare against "Fix it" below:
   ```bash
   pnpm scenario:coalescing
   pnpm scenario:lease
   pnpm scenario:stale-while-revalidate
   pnpm scenario:jittered-ttl
   ```
4. Run `pnpm test` and read through
   `tests/integration/naive-stampede.test.ts` (asserts the stampede is real -
   more than one database call) alongside the four fix tests (each asserts
   its specific guarantee: exactly 1, close to 1, fast-under-staleness, and
   a measurably wider expiration spread).

## Observe

- **PGweb** (http://localhost:8421): `products` never changes size across
  any of these scenarios - this lab is entirely about read caching, not
  writes.
- **Structured logs**: every scenario logs through `@labs/logging` (Pino)
  with `databaseCallCount`/`elapsedMs`/`succeeded` fields, so the invariant
  (or its violation) is a field in the log line, not something you have to
  infer.
- **`redis-cli -p 6421 monitor`** while a scenario runs (see
  `playground/notes.md`) - watch how many `GET`/`SET`/`EVAL` commands each
  mitigation actually issues.
- **`redis-cli -p 6421 dbsize`** before/after `pnpm seed` - the seed script
  explicitly `FLUSHDB`s, so this should read `0` right after seeding.

## Break it

Run:

```bash
pnpm scenario:naive-stampede
```

Real captured output from this lab's own validation run (seed 42,
`--size=small`, 300 concurrent requests, one cold product key):

```text
starting naive cache-aside stampede
  productId: 21   concurrentRequests: 300
STAMPEDE CONFIRMED: the cold-cache burst caused more than one database call for the same product
  productId: 21   concurrentRequests: 300
  succeeded: 300   databaseCallCount: 300   elapsedMs: 112
```

All 300 concurrent callers missed the cache and independently called the
75ms-artificial-delay `getProductFromDatabase` - a real, measured
`databaseCallCount: 300`, not a theoretical "the database would be
overloaded." `tests/integration/naive-stampede.test.ts` asserts this as
`expect(reader.getCallCount()).toBeGreaterThan(1)` with 250 concurrent
requests (a smaller number than the demo script purely to keep the test
suite fast - the point reproduces reliably well below 300).

Why this happens: Redis's `GET` on a missing key always returns nothing, no
matter how many callers ask "does this key exist yet?" in the same
millisecond - there is no signal in a miss that another caller is already
about to fill it in. Nothing in `naive-cache-aside.ts` checks for that.

## Fix it

**Fix #1 - in-process request coalescing** (only helps within one process):

```bash
pnpm scenario:coalescing
```

Real captured output, identical setup:

```text
starting request-coalescing burst (same cold-cache setup as the naive stampede)
  productId: 21   concurrentRequests: 300
FIXED: exactly one database call served the entire concurrent burst
  productId: 21   concurrentRequests: 300
  succeeded: 300   databaseCallCount: 1   elapsedMs: 80
```

**Fix #2 - a short Redis lease** (works across processes; simulated here as
5 independent `ioredis` connections, 60 requests each = 300 total):

```bash
pnpm scenario:lease
```

Real captured output:

```text
starting lease-based-refill burst across simulated processes (same cold-cache setup as the other two scenarios)
  productId: 21   simulatedProcesses: 5   requestsPerProcess: 60
FIXED (cross-process): 1 database call(s) served the entire burst across 5 simulated processes
  productId: 21   totalRequests: 300   succeeded: 300   databaseCallCount: 1   elapsedMs: 95
```

Rerun three more times back to back: `databaseCallCount` was `1` on every
run. `tests/integration/lease-based-refill.test.ts` asserts
`toBeLessThanOrEqual(2)` rather than exactly 1 - see that test's comment for
the specific, narrow, documented race this tolerance covers (a lease
expiring before its holder finishes writing the cache AND releasing the
lock), which `leaseMs` (2000ms, ~27x the 75ms simulated database delay) is
deliberately sized to make rare in practice, not to eliminate by
construction the way in-process coalescing does.

**Fix #3 - stale-while-revalidate** (trades a little staleness for
eliminating the latency spike on an expired-but-known key):

```bash
pnpm scenario:stale-while-revalidate
```

Real captured output:

```text
naive cache-aside: every miss pays the full simulated database latency
  simulatedDatabaseDelayMs: 75   naiveColdMs: 80   naiveMissMs: 79

FIXED: the stale read returned in well under the simulated database latency, and a subsequent read after the background refresh is also fast
  simulatedDatabaseDelayMs: 75   staleReadMs: 4   freshReadMs: 2   databaseCallCount: 2
```

A request arriving just after the "fresh" window (300ms) lapses - but while
the key is still within its longer "stale-acceptable" window (5000ms) -
gets its answer in **4ms**, not the ~75-80ms every naive-cache-aside miss
costs, while a background refresh (deduplicated per key via
`refreshInFlight`) brings the entry back to fresh. A second read after the
refresh completes is also fast (2ms) and required zero additional database
calls (`databaseCallCount` stayed at 2: one for the initial cold populate,
one for the background refresh).

**Fix #4 - jittered TTL** (a purely preventive measure against many keys
expiring in lockstep, not a per-key stampede fix):

```bash
pnpm scenario:jittered-ttl
```

Real captured output (200 keys per group, base TTL 2000ms, jitter +/-20%):

```text
seeding fixed-TTL and jittered-TTL key sets at (as close as possible to) the same instant
  keyCount: 200   baseTtlMs: 2000   jitterFraction: 0.2

FIXED (preventive): jittered-TTL keys expired across a measurably wider window than fixed-TTL keys
  fixedWindow: { firstExpiryMs: 2015, lastExpiryMs: 2015 }
  jitteredWindow: { firstExpiryMs: 1607, lastExpiryMs: 2408 }
  fixedSpreadMs: 0   jitteredSpreadMs: 801   pollIntervalMs: 25
```

All 200 fixed-TTL keys disappeared within a single 25ms poll tick of each
other (spread: 0ms, bounded only by poll resolution). The jittered set
started expiring 393ms *earlier* and finished 408ms *later* than the fixed
set's single instant - a measured 801ms-wide expiration window versus 0ms,
for a target +/-20% window of roughly 800ms around the 2000ms base. Rerun,
this was consistent within a few percent (`jitteredSpreadMs` between ~750
and ~830ms across several runs).

`pnpm test` captures all five as real assertions:

```text
✓ tests/integration/naive-stampede.test.ts (1 test)
✓ tests/integration/request-coalescing.test.ts (1 test)
✓ tests/integration/lease-based-refill.test.ts (1 test)
✓ tests/integration/stale-while-revalidate.test.ts (1 test)
✓ tests/integration/jittered-ttl.test.ts (1 test)

Test Files  5 passed (5)
     Tests  5 passed (5)
```

## Why the fix works

**Request coalescing.** JavaScript runs the synchronous portion of every
async function call to completion before yielding at its first `await`.
When N concurrent callers are invoked back-to-back in a tight loop (as
`runConcurrently` does), the first caller registers its in-flight promise in
a `Map` *before* it awaits anything - so by the time the second caller runs
its own synchronous prologue, the map already has an entry for that key, and
it simply awaits the same promise instead of starting a new fetch. This is a
genuine consequence of Node's single-threaded run-to-completion semantics,
not a race that happens to usually work - see `request-coalescing.ts`'s doc
comment for the precise ordering argument.

**Lease-based refill.** `SET lock:<key> <owner> NX PX <leaseMs>` is atomic in
Redis: exactly one caller's `SET` can ever succeed for a given lock key at a
time, no matter how many processes issue it concurrently. Every other caller
gets `null` back immediately and polls the actual cache key instead of
calling the database - so the coordination happens through Redis itself, not
through any one process's memory, which is exactly why this works across the
5 simulated independent connections where request coalescing's in-memory
map could not. Releasing the lease via a `GET`-then-`DEL` Lua script (rather
than a plain `DEL`) ensures a caller never deletes a lease that a DIFFERENT
caller has since (validly) acquired after this caller's own lease expired -
this is a deliberately minimal preview of the ownership-token/safe-release
concept Lab 22 covers in full.

**Stale-while-revalidate.** Every cached entry carries its own `freshUntil`
timestamp. A request past that timestamp but before the key's own (longer)
Redis TTL returns the existing value immediately - it is stale, but it exists
and is far cheaper to serve than to recompute - while a background refresh
(deduplicated per key so a burst of stale requests doesn't fire N
redundant refreshes) brings the entry current for the *next* request. The
cost is bounded and explicit: a caller can see data up to `staleMs -
freshMs` old, never anything older, and a cold key (no cached value at all)
still pays full latency exactly like naive-cache-aside.

**Jittered TTL.** `computeJitteredTtlMs` returns a value uniformly drawn from
`[base * (1 - fraction), base * (1 + fraction)]` instead of always returning
`base`. Applied when many keys are populated at (close to) the same instant,
this spreads their expirations across that whole window instead of letting
them all land in the same few milliseconds - which is what turns "many keys
expire" into a correlated burst of simultaneous misses in the first place.

## Tradeoffs

- **Request coalescing is free but incomplete.** No extra infrastructure, no
  extra network round-trip, and it eliminates the stampede's *in-process*
  contribution entirely - but a fleet of API replicas each still has its own
  in-memory map, so a cold key still produces one database call PER PROCESS,
  not one system-wide. This lab's 300-into-1 result is for a single process;
  the lease scenario's 300-into-1 result is specifically because it spans 5
  independent connections.
- **The Redis lease works across processes but adds real complexity**: an
  extra Redis round-trip per attempt, a lease-duration tuning decision
  (`leaseMs` must comfortably exceed the real operation's latency, or
  waiters will time out and duplicate work), and the safe-release concern
  this lab previews (an ownership token, not a plain `DEL`) that Lab 22
  treats in full including fencing tokens.
- **Stale-while-revalidate trades staleness for latency, and only helps
  once a key has EVER been populated.** A truly cold key (never cached
  before) gets no benefit - it still blocks on the slow database call, same
  as naive-cache-aside. It also does nothing by itself to stop N concurrent
  callers hitting a COLD key from all missing simultaneously; combining it
  with request coalescing or a lease covers both cases.
- **Jitter is the cheapest fix here but solves a different problem than the
  other three.** It does not protect any single hot key from a burst of
  concurrent misses (that needs coalescing or a lease) - it only prevents
  MANY independent keys from becoming correlated misses in the first place.
  It costs nothing beyond slightly-less-predictable individual TTLs.

## Production notes

1. **What guarantee does this mechanism give?** Request coalescing
   guarantees at most one in-flight database call per process per cache key.
   The Redis lease guarantees at most one in-flight database call
   system-wide per cache key (modulo the narrow lease-expiry race
   documented above). Stale-while-revalidate guarantees a bounded staleness
   window instead of a latency spike on expiry. Jittered TTL guarantees
   expirations of many keys populated together are spread across a window
   rather than landing simultaneously.
2. **What does it not guarantee?** None of these make Redis authoritative.
   Per `docs/architecture-principles.md` #4 ("Cache vs source of truth"),
   PostgreSQL remains the source of truth for `products`; every mechanism
   here is strictly about read latency and load, not about protecting a
   money- or inventory-shaped invariant the way Lab 12's conditional writes
   do.
3. **What breaks under process crash?** A crash mid-database-call under
   naive cache-aside or coalescing simply leaves the key uncached - the next
   request pays full latency again, no corruption. A crash while holding a
   Redis lease is why the lease has a `PX` expiry at all: the lease
   self-expires and a different caller acquires it, rather than leaving the
   key permanently unrefillable.
4. **What breaks under network partition?** A partition between the
   application and Redis degrades every mechanism here to "no cache" (every
   read falls through) if the application is written to treat a Redis error
   as a cache miss - Redis being unavailable should never be allowed to make
   the product page unavailable, only slower.
5. **What changes at high contention?** Coalescing and the lease both
   collapse arbitrarily many concurrent misses on ONE key to (about) one
   database call regardless of how high contention gets - this lab measured
   the identical 1-call result at 300 concurrent callers as it does at much
   lower counts. Stale-while-revalidate's background-refresh deduplication
   (`refreshInFlight`) provides the same property for the "many stale reads
   at once" case.
6. **What changes with multiple regions?** Not applicable yet - single Redis
   instance, no replication (see Lab 24+ for replication concepts on the
   Postgres side). A multi-region deployment would need either a
   region-local cache (accepting more regional stampede risk on cold starts)
   or a shared/replicated cache layer with its own consistency tradeoffs.
7. **What metrics would you monitor?** Cache hit rate (and specifically hit
   rate broken down by fresh vs stale under stale-while-revalidate), lease
   acquisition failure rate (a proxy for contention on hot keys), lease
   waiter timeout rate (a signal `leaseMs` is too short relative to real
   database latency), and the underlying database's own query rate/latency
   as the ground truth for whether the cache is actually doing its job.
8. **What simpler alternative could be used?** For a single-process
   deployment, request coalescing alone is simpler than a Redis lease and
   gives the identical guarantee. Jittered TTL is nearly free and should
   almost always be on regardless of which other mitigation is used.
9. **When should you avoid this technique?** Avoid stale-while-revalidate
   for data where staleness is unacceptable (a live price change that must
   apply to the very next read, for example) - reach for immediate
   invalidation instead. Avoid a Redis lease when in-process coalescing
   already covers your deployment topology (a single process, or a topology
   where each process owns a disjoint key range) - the extra Redis
   round-trips and lease-tuning burden aren't worth it.

## Interview questions

1. Why does the naive cache-aside pattern's `GET`, seen by 300 concurrent
   callers on the same missing key, provide absolutely no signal to any of
   them that another caller is already about to populate it?
2. Walk through why in-process request coalescing's `inFlight.set(key,
   promise)` is guaranteed to run before a second concurrent caller's
   `inFlight.get(key)`, given how `runConcurrently` invokes N calls back to
   back with no `await` between them.
3. Why is `SET lock:<key> <owner> NX PX <ms>` atomic, and what would break if
   this lab instead did a `GET` to check for the lock followed by a separate
   `SET` to acquire it?
4. Why does releasing the lease require comparing the stored owner token
   before deleting it, instead of a plain `DEL`?
5. Stale-while-revalidate can return data up to `staleMs - freshMs`
   milliseconds old. What kind of data would make that an unacceptable
   tradeoff, and what would you reach for instead?
6. Jittered TTL doesn't stop a single very-hot key from stampeding on its
   own expiry. Why not, and which of this lab's other three mitigations
   would you pair it with?
7. `docs/architecture-principles.md` says a cache "is not authoritative for
   invariants ... unless a lab is specifically exploring that tradeoff."
   What would go wrong if this lab's `products.price_cents` were mutable and
   the cache were treated as authoritative for checkout pricing?

## Further experiments

- Lower `SIMULATED_QUERY_DELAY_MS` in `src/db/product-repository.ts` toward
  0 and rerun `pnpm scenario:lease` several times - does the documented
  "close to 1, tolerance 2" ever actually hit 2 on your machine? What does
  that tell you about how `leaseMs` should relate to the real operation's
  latency in production?
- Deliberately set `leaseMs` shorter than `SIMULATED_QUERY_DELAY_MS` in a
  scratch copy of `lease-based-refill.ts` and rerun the lease scenario -
  watch `databaseCallCount` climb as waiters time out and re-acquire fresh
  leases while the original holder is still working.
- Add a Pino `attempt` field inside `lease-based-refill.ts`'s retry loop and
  observe how many attempts a waiter needs under contention.
- Change `JITTER_FRACTION` in `run-jittered-ttl.ts` to `0` and confirm the
  jittered set's measured spread collapses to look just like the fixed set's
  (this is a good sanity check that the jitter code, not measurement noise,
  is what produces the 800ms spread).
- Combine stale-while-revalidate with request coalescing: extend
  `stale-while-revalidate.ts`'s cold-miss branch to use the same in-flight
  map as `request-coalescing.ts`, and write a test proving a COLD key under
  concurrent load now also collapses to one database call, closing the gap
  noted in "Tradeoffs."
