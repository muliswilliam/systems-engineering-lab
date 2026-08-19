# Lab 40 — Production Capstone

## Why this exists

Labs 01-39 each taught ONE mechanism in isolation: transactions, idempotency,
the transactional outbox, `SKIP LOCKED` job claiming, rate limiting, circuit
breakers, and dozens more. Real backend incidents rarely come from a single
mechanism failing on its own — they come from several mechanisms that are
each individually correct, but were never tested TOGETHER, interacting badly
under load. This capstone builds one small, genuinely working system — a
ticketing/booking platform — and demonstrates a system-level failure that
only manifests because two previously-safe mechanisms (a checkout endpoint
with no idempotency guard, and an outbox worker with no circuit breaker)
compound each other, then fixes both and proves the fix holds with the exact
same real-load scenario.

## Learning objectives

After this lab you should be able to:

- explain why "each mechanism works in isolation" is not the same claim as
  "the composed system is safe," and give a concrete example;
- trace a duplicate-request retry storm through a multi-step pipeline
  (checkout → outbox → worker → downstream) and predict where it compounds;
- compose idempotency (Lab 15), the transactional outbox (Lab 16/17),
  `SKIP LOCKED` claiming (Lab 14), and a circuit breaker (Lab 37) into ONE
  transaction/worker pair, and explain the layering order that makes it work;
- measure, not assume, that a fix holds under real concurrent load — this
  lab's own tests assert exact counts, not "it seems fine";
- reason about which mechanism is responsible for which guarantee when two
  or more are stacked (idempotency bounds ORDER count; the breaker bounds
  DOWNSTREAM CALL count; neither one alone bounds both).

## Architecture

```text
┌─────────────┐     BEGIN                              ┌──────────────┐
│  checkout   │────▶ idempotency key (Lab 15)           │    seats     │
│  handler    │     conditional seat UPDATE (Lab 11/12) │  (RESERVED   │
│             │     orders INSERT                       │   → SOLD)    │
│  Lab 36     │     outbox_events INSERT (Lab 05/16)    └──────────────┘
│  rate limit │     COMMIT
└─────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │  outbox_events   │  status: pending → processing → published/failed
                    └──────────────────┘
                              │  SELECT ... FOR UPDATE SKIP LOCKED  (Lab 14/17)
                              ▼
                    ┌──────────────────┐      circuit breaker (Lab 37, OUTERMOST)
                    │  outbox worker   │────▶   retryWithBackoff (INSIDE breaker.execute)
                    │                  │          withTimeout (INSIDE each retry attempt)
                    └──────────────────┘              │
                                                       ▼
                                          ┌─────────────────────────┐
                                          │ NotificationService      │
                                          │ (simulated email/SMS,    │
                                          │  seeded, health-modeled) │
                                          └─────────────────────────┘
```

Each mechanism is reused as a CONCEPT from its own lab, reimplemented fresh
here per this repository's independent-labs principle (no lab imports
another lab's code):

| Mechanism | Taught standalone in | Reused here for |
|---|---|---|
| Conditional-write seat reservation | Lab 11 (conditional writes), Lab 12 (job-queue-shaped state machine) | `src/seats/reserve-seat.ts` — exactly one concurrent reservation attempt wins |
| Transactions / atomicity | Lab 05 | Every checkout is one `BEGIN`/`COMMIT` covering the order write, the seat transition, and the outbox write |
| Idempotency key + `UNIQUE` constraint | Lab 15 | `orders.idempotency_key`, `INSERT ... ON CONFLICT DO NOTHING RETURNING *` |
| Transactional outbox | Lab 16/17 | `outbox_events` committed in the SAME transaction as the order |
| `SELECT ... FOR UPDATE SKIP LOCKED` | Lab 14/17 | `src/outbox/claim.ts` — concurrent workers never double-claim an event |
| Timeouts / retry-with-backoff / circuit breaker | Lab 37 | `src/lib/timeout.ts`, `src/lib/retry.ts`, `src/lib/circuit-breaker.ts` — wraps every notification call |
| Rate limiting (Redis token bucket) | Lab 36 | `src/lib/rate-limiter.ts` — gates the checkout API boundary |
| Structured logs + correlation IDs + a `/metrics` endpoint | Lab 38's techniques | `src/lib/correlation.ts`, `src/lib/metrics.ts` — one correlation ID per logical checkout request, threaded through every log line |

**Domain scope**: a deliberately small ticketing schema (`events`, `seats`,
`orders`, `outbox_events`, `notification_attempts`) — not SPEC.md 8.2's full
venue/section/inventory/payments model. The lesson here is composing
mechanisms, not modeling a rich domain; a bigger schema would only add noise
around the same five tables' worth of real behavior. `notification_attempts`
is a pure observability log — nothing reads it to decide behavior — so an
operator can reconstruct exactly what the notification pipeline did during
an incident (attempt count, outcome, breaker state, latency) without
grepping raw logs.

**Why idempotency and rate limiting are kept orthogonal**: the rate limiter
protects the API boundary from too many REQUESTS; idempotency protects
business state from too many EFFECTS from requests that got through. A
generous rate limit (200/sec in the composed scenario) still lets all 20
duplicate retries through — rate limiting alone would not have caught this
bug. That is the point: they solve different problems and this lab does not
let one substitute for the other (see Lab 36's own README for the same
distinction argued in isolation).

## Setup

```bash
cd labs/40-production-capstone
cp .env.example .env
docker compose up -d
pnpm db:migrate
pnpm seed
```

Ports: Postgres `5440`, PGweb `8440` (http://localhost:8440), Redis `6440`,
a metrics server (`pnpm dev`) on `9440` (http://localhost:9440/metrics).

## Scenario

A customer clicks "buy" on a seat. Their browser's HTTP layer does not
receive a response before its own timeout fires — SPEC.md Lab 15's own
motivating scenario — so it resends the identical logical checkout request.
Under real network conditions this is not a rare edge case: mobile clients,
proxies, and load balancers all have their own timeout/retry behavior a
backend does not control. This lab models it as 20 concurrent duplicate
`checkout` calls against the same reserved seat, all "from" the same
customer, arriving within the same short window.

Separately, the order-confirmation notification service occasionally has
degraded or fully-down windows — again not a rare edge case, every real
downstream dependency has bad days.

**Neither of these alone is a new problem** — Lab 15 already taught
idempotency for exactly the "duplicate request" case, and Lab 37 already
taught circuit breakers for exactly the "struggling downstream" case. The
capstone's actual subject is what happens when BOTH occur in the SAME
system at the SAME time, and neither mechanism has been added yet: a
duplicate-checkout storm does not merely create a few extra database rows —
it creates a few extra database rows that EACH generate their own outbox
event, and a naive worker with no circuit breaker will retry the downstream
call for EVERY one of them, turning one customer's network hiccup into a
20x amplification of load against an already-struggling notification
provider. This is the compounding effect: two mechanisms, each fine alone,
interacting badly.

## Prediction

Before running anything: if 20 duplicate checkout requests hit a naive
(no-idempotency) checkout handler for the same seat, how many `orders` rows
will exist afterward? How many `outbox_events` rows? If the notification
downstream is degraded and a naive worker (no backoff, no breaker) drains
that outbox, roughly how many real calls will it make to the downstream —
close to the number of orders, or some multiple of it?

## Exercise

```bash
pnpm scenario:naive-duplicate-storm
```

Read the real captured output. Then:

```bash
pnpm scenario:composed-duplicate-storm
```

Compare the `orders`/`outbox_events` counts and the real downstream call
count between the two runs.

## Observe

Real captured output from this lab's own validation run (`pnpm seed` between
each scenario to reset to a clean 30-seat baseline):

**Naive path** (`pnpm scenario:naive-duplicate-storm`, notification health
`degraded`):

```text
THE BUG: one logical checkout produced multiple orders and multiple outbox events
  duplicateRequests: 20
  checkoutsCreated: 20
  distinctOrdersInDb: 20
  outboxEventsCreated: 20
  checkoutDurationMs: 60

THE COMPOUNDING EFFECT: 45 real calls were made to the struggling downstream
to (attempt to) notify ONE customer 20 separate time(s) about what should
have been a single order
  claimAttemptsPublished: 20
  claimAttemptsFailed: 3
  notificationCallsMade: 45
  distinctCustomersActuallyNotified: 20
  drainDurationMs: 9318
```

Twenty concurrent duplicate HTTP-layer retries of ONE logical purchase
became 20 real database orders, 20 real outbox events, and 45 real
network-level calls to a downstream that was already degraded — and the
customer would have received up to 20 separate confirmation emails/SMS for
one seat.

**Composed path** (`pnpm scenario:composed-duplicate-storm`, notification
health `down` — a strictly harder condition, chosen deliberately so the
breaker's own contribution is separately measurable from idempotency's):

```text
THE FIX HOLDS: exactly 1 order and 1 outbox event exist for the 20-way
duplicate storm, no matter how many retries arrived
  duplicateRequests: 20
  newlyCreated: 1
  duplicatesSuppressed: 19
  distinctOrdersForStormSeat: 1
  totalOutboxEventsCreated: 9   (1 from the storm seat + 8 from 8 genuinely distinct legitimate customers checking out in the same window)
  checkoutDurationMs: 18

THE BREAKER'S CONTRIBUTION: only 9 real downstream calls were made across
27 claim attempts - 24 were rejected LOCALLY once the breaker tripped,
without ever touching the struggling downstream
  claimAttemptsPublished: 0
  claimAttemptsFailed: 27
  circuitOpenRejections: 24
  notificationCallsMade: 9
  finalBreakerState: OPEN
```

Twenty duplicate requests for the same purchase now produce exactly 1 order
and exactly 1 outbox event — idempotency alone already prevented the
database-side amplification. Separately, of 27 total claim attempts across
all 9 real outbox events in this run, only 9 ever reached the (fully down)
downstream at all; the other 24 were rejected by the OPEN breaker in ~0ms,
with zero additional load placed on the struggling service.

## Break it

```bash
pnpm scenario:naive-duplicate-storm
```

Watch `distinctOrdersInDb` climb to 20 and `notificationCallsMade` climb
into the dozens for what should have been one purchase. Then query the
database directly:

```sql
SELECT count(*) FROM orders WHERE seat_id = (SELECT MIN(id) FROM seats);
-- 20, not 1
```

## Fix it

```bash
pnpm scenario:composed-duplicate-storm
```

The fix is two independent changes, each addressing a different half of the
compounding effect:

1. **`checkoutIdempotent`** (`src/checkout/checkout-idempotent.ts`) replaces
   `checkoutNaive`'s server-generated-every-call idempotency key with a
   caller-supplied key reused across every retry, gated by
   `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING *` inside
   the same transaction as the seat transition and the outbox write.
2. **`createProtectedWorker`** (`src/outbox/worker-protected.ts`) wraps the
   identical `SKIP LOCKED` claim's notification call in a circuit breaker
   (outermost) around `retryWithBackoff` (inside) around `withTimeout`
   (innermost per attempt) — Lab 37's own argued layering order.

## Why the fix works

**Idempotency bounds the number of ORDERS** (and therefore outbox events) to
exactly one per logical purchase, regardless of how many duplicate HTTP
requests arrive — the guarantee comes from Postgres's own `UNIQUE` index on
`idempotency_key`, evaluated atomically per `INSERT`, not from application
coordination. **The circuit breaker bounds the number of real DOWNSTREAM
CALLS** once a failure threshold is crossed, regardless of how many outbox
events are still pending — the guarantee comes from the breaker's own state
machine refusing to even attempt a call while OPEN, not from the downstream
recovering.

Neither one alone closes the loop this capstone is built around. Idempotency
alone still leaves a naive worker retrying ONE real event's notification
without backoff on every claim cycle — fewer calls than the naive-storm's
45, but still unbounded per event if the downstream never recovers, since
nothing stops indefinite reclaim-and-retry. A circuit breaker alone, with no
idempotency, still lets 20 duplicate orders exist — the breaker would simply
also throttle the (wrongly) 20x-amplified load, hiding the real bug (extra
paid orders for one seat) behind a smaller number of failed notification
attempts. **Composed, each mechanism does the job it is actually good at**:
idempotency collapses N duplicate requests to 1 logical unit of work before
the outbox layer ever sees more than one event; the breaker then bounds how
hard that ONE event's delivery attempts hit a struggling downstream. The
end-to-end invariant test (`tests/integration/end-to-end-invariant.test.ts`)
asserts this directly: 50 concurrent duplicates against a fully-down
downstream still produce exactly 1 order, exactly 1 outbox event, and at
most 9 real downstream calls (bounded by `maxAttempts=3` × up to 3 reclaim
cycles) — a number that would be identical whether 5 or 5,000 duplicates
had arrived, because idempotency already collapsed them before the breaker
ever mattered.

## Tradeoffs

- **More moving parts, more failure surface to reason about.** This one
  checkout function now has three failure modes to think through instead of
  one (idempotency-key collision handling, conditional-write rejection, and
  the outbox write itself) — each individually simple, but a reviewer has
  to hold all three in mind at once.
- **Idempotency keys must be generated and stored correctly by the CALLER**,
  not the server — this capstone's scenarios generate the key once before
  the first attempt and reuse it explicitly; a real client library has to
  get this right too, and this lab does not model a buggy client that
  regenerates its key on every retry (that is `checkoutNaive`'s bug,
  deliberately, to teach the failure — see Lab 15's own README for the full
  treatment of client-side idempotency-key discipline).
- **The composed scenario's circuit breaker is per-worker-process, in
  memory** — a real deployment running multiple worker replicas would need
  either a shared (e.g. Redis-backed) breaker state or would accept that
  each replica trips independently, which changes the math on how many real
  calls reach a struggling downstream before ALL replicas have tripped (see
  Lab 37's own README "Production notes" for this exact caveat, unchanged
  here).
- **What a smaller team might cut**: the separate `notification_attempts`
  observability log is the first thing to drop if this were a real system
  under time pressure — nothing reads it to make decisions, and a real
  system would more likely get this from structured logs plus a metrics
  dashboard (Lab 38's approach) rather than a dedicated table. It is kept
  here because it makes the "operator's-eye view of an incident" concretely
  queryable in one SQL statement without needing a log aggregator running.
- **Rate limiting configured generously on purpose.** A stricter limit would
  have rejected some of the 20 duplicate requests outright, which would
  make the demo LESS convincing that idempotency (not rate limiting) is
  what's actually protecting order correctness — see "Architecture" above.

## Production notes

1. **What guarantee does this composed system give?** Exactly one order and
   one outbox event per logical checkout request, regardless of how many
   times the client retries; a bounded (not unbounded) number of real calls
   to the notification downstream regardless of how degraded that
   downstream is.
2. **What guarantee does it not give?** It does not guarantee the customer
   is EVENTUALLY notified — a downstream that never recovers within
   `max_attempts` leaves the outbox event `failed` permanently (this lab
   does not implement a dead-letter/manual-retry UI, see "Further
   experiments"). It also does not protect against a caller that generates
   a FRESH idempotency key per retry (a client-side bug, out of this
   system's control — see Lab 15's own treatment).
3. **What failure mode remains?** A worker process crash between claiming an
   event (`status = 'processing'`) and marking it published/failed leaves
   the event reclaimable only once `locked_until` lapses (Lab 14/17's own
   lease-timeout mechanism) — there is a real window where no worker is
   actively retrying that event.
4. **How does contention affect it?** The `orders.idempotency_key` UNIQUE
   index serializes concurrent duplicate requests for the SAME key at the
   database level — under N-way concurrency, exactly one wins the `INSERT`
   and the rest fall through to the fallback `SELECT`, all correctly, but
   all N still pay a real database round trip.
5. **What changes at larger scale?** More outbox events pending at once
   means more `SKIP LOCKED` claim contention across a larger worker pool —
   this lab's own `outbox_events_status_created_at_idx` keeps the claim
   query's `ORDER BY created_at, id` cheap at the row counts this lab
   seeds; a real system at much higher volume would need to watch this
   index's own bloat (Lab 31) and consider partitioning `outbox_events` by
   time (Lab 35) once old published/failed rows accumulate.
6. **What metrics would be monitored?** `capstone_checkout_duplicate_suppressed_total`
   vs `capstone_orders_created_total` (ratio tells you how much duplicate
   traffic idempotency is absorbing), `capstone_circuit_breaker_open_total`
   and time-in-OPEN (tells you how much load the breaker is shielding the
   downstream from), outbox `pending`/`failed` row counts over time (a
   growing `failed` count with a healthy downstream means something else is
   wrong — see Lab 17's own outbox-monitoring guidance).
7. **When should this approach be avoided?** For operations that are
   naturally idempotent already (e.g. `SET x = 5` rather than `x = x + 1`),
   the idempotency-key machinery is pure overhead — reserve it for
   operations with real side effects (charges, seat sales, sends). For a
   downstream with no meaningful "open" state (e.g. a pure, stateless
   computation with no rate limit or capacity of its own), a circuit
   breaker adds complexity without a corresponding guarantee.

## Interview questions

- Why does `checkoutIdempotent` re-use the SAME already-checked-out
  `pg.Pool` client for its fallback `SELECT` instead of calling
  `pool.query()` again? What would go wrong under concurrency if it didn't?
- Idempotency and circuit breakers each bound a different quantity in this
  system. Name both quantities and explain why bounding one does not bound
  the other.
- Why is the composed scenario's notification downstream set to `down`
  rather than `degraded` (the naive scenario's setting)? What would change
  about what the breaker's contribution demonstrates if both scenarios used
  the same downstream health?
- The circuit breaker in this lab is per-process, in-memory. What changes if
  this system runs 5 worker replicas instead of 1?
- Why does the transactional outbox write happen in the SAME transaction as
  the order/seat-status write, rather than immediately after `COMMIT`?

## Further experiments

- Add a dead-letter path: once an outbox event reaches `status = 'failed'`
  permanently, write it somewhere an operator (or an alerting rule) can act
  on, rather than leaving it silently `failed` in the same table.
- Implement seat-hold expiration (`reserved_until` already exists in the
  schema) — a background sweep that returns expired `RESERVED` seats to
  `AVAILABLE`, and observe what happens to a checkout attempt racing that
  sweep.
- Swap the in-memory `CircuitBreaker` for a Redis-backed shared state (Lab
  36's rate limiter is already Redis-backed — the same atomic-Lua-script
  technique applies) and re-run the composed scenario with 3 simulated
  worker processes instead of 1.
- Wire this lab's own `/metrics` endpoint into Lab 38's Prometheus
  docker-compose service and watch `capstone_circuit_breaker_open_total`
  and `capstone_checkout_duplicate_suppressed_total` move in real time
  during a live `pnpm scenario:composed-duplicate-storm` run.
- Raise `DUPLICATE_REQUESTS` in both storm scenarios from 20 to 200 and
  confirm the composed scenario's downstream call count barely changes
  while the naive scenario's grows roughly linearly — that gap is this
  lab's whole thesis, made larger and more dramatic.
