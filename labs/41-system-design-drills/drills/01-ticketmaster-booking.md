# Drill 01 - Ticketmaster-style booking

## Prompt

Design a ticket-booking system for on-sale events (a popular concert, a
playoff game). At the moment a big on-sale opens, tens of thousands of
users hit the same handful of popular seats within seconds. The system
must never sell the same seat twice, must let a user briefly hold a seat
while they enter payment details, must handle a payment provider that is
sometimes slow, and must serve event/seat-map pages to a global user base
without every page view hitting the primary database. Target: sustained
bursts of 10,000 requests/second at checkout endpoints during a hot
on-sale.

Do your own prediction (see the top-level README) before reading on.

## Model answer

### 1. Invariants

- A seat's terminal state transition (`AVAILABLE -> RESERVED -> SOLD`) is
  entered by at most one successful writer; every other concurrent
  attempt on the same seat observes failure, not partial success.
- A `RESERVED` seat that is never paid for returns to `AVAILABLE` after
  its hold expires - exactly once, not zero times (seat stuck locked
  forever) and not more than once (double-release corrupting a
  simultaneously-in-progress new reservation).
- A payment retry (the client's HTTP layer retrying after a timeout, not
  a new purchase attempt) must not create a second order for the same
  logical checkout.

### 2. Consistency requirements

The seat-state transition itself needs **strong consistency**: it is a
single-row invariant, and Lab 12 exists specifically to show that a naive
read-then-write on this exact invariant lets 73-100 of 100 concurrent
attempts believe they reserved the same seat. Reading the event/seat-map
*page* (name, venue, price, general availability) tolerates
**eventual consistency** - a few hundred milliseconds of staleness on a
marketing page costs nothing, unlike a few hundred milliseconds of
staleness on the seat-state row itself.

### 3. Storage choice

Postgres is the source of truth for seat state and orders, per this
curriculum's recurring principle (CLAUDE.md Core Principle 3): the
invariant is a datastore-native one (a single-row state machine, checkable
with a `WHERE` clause), so it belongs in the datastore, not in an
application-level coordinator. Redis sits in front of it only for the
read-heavy event page (Lab 21), never as the seat-state system of record.

### 4. Concurrency mechanism

**Reservation**: a conditional write, `UPDATE seats SET status =
'RESERVED', ... WHERE id = ? AND status = 'AVAILABLE'` - exactly Lab 12's
fix, which took the same 100-concurrent-attempt race that let the naive
read-then-write approach succeed for 73-100 attempts and made it succeed
for exactly 1, every time. Lab 12 also validates the row-lock alternative
(`SELECT ... FOR UPDATE`) as an equally-correct option; the conditional
write is generally preferred here because it needs no explicit
transaction span held across a round trip and reads naturally as "do this
write only if this precondition still holds."

**Expiry**: the same conditional-write shape run by a background worker,
`UPDATE seats SET status = 'AVAILABLE' WHERE status = 'RESERVED' AND
reserved_until < now()` - Lab 12's own expiry-worker pattern. Because it
is a conditional write keyed on current state, running it twice against
the same already-expired-and-released row is harmless (the second run's
`WHERE` clause simply matches zero rows) - the mechanism is naturally
idempotent, which matters because a scheduled worker can and will
sometimes overlap with itself.

**Checkout/payment**: an idempotency key on the checkout request, enforced
with `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`
plus a fallback `SELECT` on conflict - Lab 15's exact pattern, proven to
turn 10 concurrent same-key retries into exactly 1 persisted row with
every caller (not just the "winning" one) receiving the identical
response, including for a result that is non-deterministic to compute
(a confirmation code) but deterministic to *return* once persisted. This
is composed with the seat-completion transition (`RESERVED -> SOLD`,
requiring a valid, unexpired reservation token, per Lab 12) inside one
transaction, and with the same idempotency-plus-outbox composition Lab
40's capstone used for its own checkout path.

**Checkout burst control**: a Redis token-bucket rate limiter (Lab 36) at
the checkout boundary - Lab 36 measured the *exact* `allowed: 100,
rejected: 20` split from a 120-concurrent-request burst against a
100/sec budget, in 5ms, because the limiter is one atomic Lua script, not
a race between separate read-then-write steps. This protects the payment
provider and the checkout path from being the thing that falls over
during the on-sale spike, independent of whether the underlying seat
invariant holds (it always does, per the conditional write above,
regardless of load).

**Event/seat-map page reads**: cache-aside (Lab 21) with one of Lab 21's
measured stampede mitigations, not naive cache-aside alone - a 300
concurrent request burst against a naive cold cache produced a real
`databaseCallCount: 300` (one full database hit per concurrent miss);
request coalescing collapsed the identical burst to `databaseCallCount: 1`.
For an event page specifically, stale-while-revalidate is the best fit of
Lab 21's four mitigations (a stale read at 4ms is a fine experience for
"is there still availability," and the background refresh keeps it
converging), with jittered TTL preventing every popular event's cache
entry from expiring in the same poll tick and re-stampeding.

### 5. Failure modes

- **Reservation-expiry worker crashes mid-run**: harmless, because the
  conditional `UPDATE` it runs is naturally resumable/idempotent (see
  above) - the next scheduled run picks up exactly the rows still meeting
  the `WHERE` clause.
- **Checkout retried after a client-observed timeout**: covered by the
  idempotency key; the *server-side* work may have already completed
  (Lab 37's own lesson: a downstream can commit its effect and only the
  *response* gets lost to the timeout) and the retry must reuse, not
  regenerate, the idempotency key for this to hold.
- **Payment provider is slow or down**: wrap the call in Lab 37's
  timeout + retry-with-jittered-backoff + circuit breaker composition
  (breaker outermost, retry inside it, timeout inside each attempt) so a
  degraded provider does not tie up the checkout worker pool the way a
  missing timeout tied up a caller for the full 5000ms of a hung
  downstream in Lab 37's own naive scenario.
- **Redis (cache or rate limiter) is unavailable**: the event page falls
  back to hitting Postgres directly (slower, but correct - Redis was
  never the source of truth for availability); the rate limiter failing
  open or closed is a real product decision, but either way the seat
  invariant itself is unaffected, because it was never enforced by Redis.
- **Read replica lag makes a "sold out" event page look like it still has
  availability** (or vice versa): acceptable for the page per the
  consistency requirements above, but the *actual* checkout attempt still
  goes through the conditional write against the primary, so a stale page
  produces, at worst, a disappointing "sorry, that seat is gone" message
  after checkout - never an oversold seat.

### 6. Scale estimate

10,000 req/sec at checkout is dominated by connection and lock-contention
behavior on the small number of hot seat rows during a popular on-sale,
not by raw throughput of unrelated rows. Lab 14's `SKIP LOCKED` numbers
are the closest real evidence for "many workers, contested resource, no
coordinator": 50 concurrent workers claiming from a shared pool resolved
in 125ms with zero double-claims, and losing a race to `SKIP LOCKED`
costs ~10ms versus ~312ms of real blocking behind a plain `FOR UPDATE`
holder in the same lab - conditional writes on a *specific* contested
seat row behave similarly: a loser gets `rowCount: 0` back immediately
(no blocking wait at all, per Lab 11), which is why conditional writes,
not row locks, are the better fit for a single, extremely hot row under
an on-sale burst. PgBouncer in transaction-pooling mode (Lab 23) sits in
front of Postgres so that 10,000 concurrent application-layer requests
do not require 10,000 real Postgres backends - Lab 23 measured 60
concurrent clients funneled cleanly through a `default_pool_size=10`
pool with zero rejections, versus 21 real `SQLSTATE 53300` connection
rejections when the same burst connected directly against a
lowered-`max_connections` Postgres.

### 7. Observability

- Structured logs per attempt with `seatId`, `userId`, `attempt`, and
  outcome (Pino, per CLAUDE.md's logging standard) - the same fields Lab
  12/14's own concurrency tests rely on to distinguish "my write lost the
  race" from "an actual error."
- `pg_locks`/`pg_stat_activity` watched live on the hot seat rows during
  a real on-sale window (Lab 10's own inspection queries), to see
  real-time contention depth rather than only after-the-fact success
  counts.
- Outbox lag and circuit breaker state for the payment/notification path
  (Lab 40's own `notificationCallsMade` / `circuitOpenRejections` style
  counters) - a breaker that is OPEN during a big on-sale is a signal
  worth paging on, not silently absorbing.
- Cache hit rate and coalesced-vs-real-database-call ratio for the event
  page (Lab 21's own `databaseCallCount` metric shape).

## Common wrong answer

**"Use a Redis lock (`SET seat:123 NX PX 5000`) per seat to prevent
overselling."** This is the single most common wrong answer to this exact
prompt, and this repository has direct, measured evidence against it: Lab
22 built exactly this kind of lock and showed a lock held for a 200ms TTL
by a worker doing 400ms of unrenewed work let a second worker acquire the
"same" lock 261ms in, with both workers writing real overlapping
timestamps to the same row and zero errors raised anywhere in the
process. A seat-reservation lock with a real payment-entry pause (a human
filling out a card form, which can easily exceed any TTL you would
reasonably pick) is exactly this scenario. The seat-state invariant is a
single-row state transition Postgres can enforce atomically and for free
via a conditional write; a distributed lock adds a whole new failure mode
(lease expiry while work continues) to solve a problem Postgres already
solves without it. Redis remains useful in this design - for the read
cache and the rate limiter - just not for the correctness invariant
itself.

## Interview questions

- Why is a conditional write preferred over `SELECT ... FOR UPDATE` for
  the single hottest seat in an on-sale, even though Lab 12 shows both
  are correct?
- The reservation-expiry worker and a user's in-flight payment race on
  the same seat. Walk through the interleaving where the expiry worker
  runs one query behind the payment's completion query, and explain why
  the invariant still holds.
- A colleague proposes decrementing an "available count" in Redis instead
  of managing individual seat rows, for speed. What does that break, and
  which lab's "cache vs. source of truth" evidence would you cite?
- The rate limiter and the seat-availability check are two separate
  systems (Redis token bucket vs. Postgres conditional write). Why is it
  correct for them to disagree in different directions (rate limiter
  rejects a request the seat check would have allowed, or vice versa)?
- At what request volume does the conditional-write approach on one
  single row stop scaling, and what would you change first?
