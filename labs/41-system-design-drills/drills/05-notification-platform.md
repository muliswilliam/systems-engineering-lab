# Drill 05 - Notification platform

## Prompt

Design a notification platform that sends emails/SMS/push notifications
triggered by business events elsewhere in the system (order shipped,
payment received, password reset). Every triggering event must reliably
result in an attempted notification. The platform must not spam a user
with duplicate notifications for the same event, and a slow or down
notification provider must not back up or crash the rest of the system.

Do your own prediction before reading on.

## Model answer

### 1. Invariants

- Every business event that should trigger a notification results in at
  least one delivery attempt, even if the process that generated the
  event crashes immediately after.
- A single business event never results in an unbounded number of
  delivery attempts reaching the user - retries and reclaim-after-crash
  are bounded and, ideally, do not double-send to the *user*, even though
  they may re-call the *provider*.
- Generating the notification decision must not require the triggering
  business transaction (e.g. "order shipped") to itself succeed or fail
  based on whether the notification provider is currently reachable.

### 2. Consistency requirements

The decision "this event happened, so a notification should be sent"
must be **strongly consistent** with the triggering business write - it
cannot be lost even if written a moment before a crash. The actual
delivery is **eventual and best-effort** - a notification arriving a few
seconds (or, during a provider outage, minutes) late is an acceptable
product tradeoff; a notification that silently never gets attempted at
all is not.

### 3. Storage choice

Postgres for the durable record of "a notification is owed" and its
delivery attempts (`outbox_events` / `notification_attempts`, the shape
Lab 40's capstone used for its own notification path); no message broker
is required at this design's assumed scale, per this curriculum's
recurring guidance to avoid adding infrastructure (Kafka/RabbitMQ) unless
the concept genuinely needs it - `SKIP LOCKED` workers reading directly
from Postgres, below, already provide multi-worker fan-out.

### 4. Concurrency mechanism

**Recording that a notification is owed, atomically with the triggering
business write**: the transactional outbox, Lab 16's exact mechanism
(`BEGIN; write business state; INSERT outbox_event; COMMIT`). Lab 16
demonstrated the naive alternative failing in both directions with real
captured evidence - a business write commits while a synchronous,
in-request call to the provider fails, and there is no durable record left
to retry from; or a provider call is (believed to have) succeeded while
the surrounding business write is rejected (Lab 16's own real `CHECK`
violation, `SQLSTATE 23514`), leaving the provider having sent a
notification for something that, from the business's perspective, never
happened. The outbox row is written in the *same* transaction as the
triggering event, so it exists if and only if the event itself is
durable.

**Draining the outbox across multiple worker processes**: `SELECT ... FOR
UPDATE SKIP LOCKED`, Lab 17's exact pattern - Lab 17 measured 10 workers
draining 30 seeded events with zero double-claims in 30ms, and 300 events
drained the same way in 119ms, real evidence this scales by adding
workers rather than needing a coordinator.

**Calling the actual notification provider (email/SMS/push API)**: Lab
37's full composition around each attempt - per-attempt timeout
(innermost), exponential backoff with jitter for transient failures, and
a circuit breaker (outermost) so a provider outage does not let every
queued notification's own retry loop hammer it in lockstep. Lab 40's
capstone measured the concrete payoff of this composition directly for
this exact problem shape: a naive worker with no breaker, draining an
outbox against a degraded downstream, made a real `notificationCallsMade:
45` attempting to notify *one* customer 20 separate times over a
`drainDurationMs: 9318`; the protected worker (breaker + idempotency
together), replaying a comparable duplicate-heavy storm against a fully
down downstream, made only `notificationCallsMade: 9` real calls while
`circuitOpenRejections: 24` were rejected locally in ~0ms once the
breaker tripped.

**Preventing duplicate delivery from re-processing the same outbox row**
(a worker crashes after the provider genuinely received the call, but
before recording success): this is the exact limitation Lab 17 proved
`SKIP LOCKED` alone does *not* solve - its own crashed-publisher
demonstration produced a real `brokerCallCount: 2` for one logical event.
Two complementary defenses apply: (a) many notification providers accept
a client-supplied idempotency/dedup key per message, which turns a
provider-level duplicate call into a provider-level no-op - use it where
available; (b) where it is not available, Lab 18's inbox pattern (an
`INSERT ... ON CONFLICT (message_id) DO NOTHING` dedup check plus the
side effect inside one transaction) applied at the point closest to the
actual user-visible send, verified in Lab 18's own tests to hold under
both sequential and 10-20-way concurrent redelivery.

**Provider-side rate limits**: a token-bucket limiter (Lab 36's atomic
Redis Lua script, measured at an exact `allowed: 100, rejected: 20` split
from a 120-request burst in 5ms) applied per provider/per account, so the
platform's own outbox-draining throughput never exceeds what the
downstream provider's API contract allows - independent of, and
composed with, the circuit breaker above (the limiter shapes *steady-
state* volume; the breaker reacts to the provider actually failing).

### 5. Failure modes

- **The process that wrote the triggering business event crashes
  immediately after commit**: harmless - the outbox row already committed
  in the same transaction, and any `SKIP LOCKED` worker will pick it up.
- **A `SKIP LOCKED` worker crashes mid-delivery, after the provider
  already accepted the call**: the event's lease expires and a different
  worker retries it, producing a real duplicate *provider* call (Lab
  17's own `brokerCallCount: 2` evidence) - covered by provider-level
  idempotency keys or the inbox pattern above, not by `SKIP LOCKED`
  itself.
- **The notification provider is degraded (slow, intermittent errors) or
  fully down**: the circuit breaker composition bounds both the wasted
  call volume (Lab 37/40's own measured reduction) and the worker-pool
  time spent per doomed attempt; the outbox simply grows during the
  outage and drains once the breaker closes again, rather than any event
  being lost.
- **A duplicate-checkout-style storm generates many outbox events for the
  same logical trigger** (e.g. a client retry duplicates the triggering
  request itself, not just the notification): this is a Drill 03-style
  idempotency problem one layer up, not a notification-platform problem -
  Lab 40's capstone shows the fix belongs at the point the duplicate
  request is created (idempotency key on checkout), and the notification
  platform's own job is only to not multiply an already-duplicated
  trigger further, which the breaker/rate-limiter combination above
  already bounds.

### 6. Scale estimate

Outbox draining scales the same way Lab 14/17 both measured directly for
`SKIP LOCKED` claiming - roughly linearly with worker count, with a
losing claim costing ~10ms rather than blocking behind a winner. The
practical ceiling in this design is usually the notification provider's
own rate limit, not the Postgres claiming step - which is exactly why
the token-bucket limiter sits at that boundary rather than at the
database.

### 7. Observability

- Outbox lag (age of the oldest un-published row) as the primary health
  signal - a growing lag during normal operation means workers are
  under-provisioned; a growing lag with a tripped circuit breaker means
  the provider, not the platform, is the bottleneck.
- Circuit breaker state and per-provider `notificationCallsMade` /
  `circuitOpenRejections` counters, exactly Lab 40's own metric shape.
- Structured logs correlating a business event ID through outbox write,
  claim, and delivery attempt (Lab 38's correlation-ID pattern, which
  recovered exactly one request's own 5-line path out of 27 interleaved
  concurrent lines with zero cross-contamination) - essential here
  because "why didn't customer X get notified" is the single most common
  support question this platform will need to answer.
- Delivery success/failure counters per channel (email/SMS/push), so a
  degraded provider on one channel does not get averaged away by healthy
  volume on another.

## Common wrong answer

**"Call the notification provider synchronously, inside the same request
that creates the triggering business event (e.g. inside the order-
creation handler), so the caller can immediately confirm the notification
was sent."** This is wrong for two compounding reasons this repository
has direct evidence for. First, it reproduces the exact dual-write problem
Lab 16 exists to fix: what happens if the business write succeeds and the
provider call fails, or the reverse? There is no transaction spanning a
database write and an external HTTP call. Second, it couples the
triggering request's own latency and success to the notification
provider's health - Lab 37's own naive-hang measurement (a caller with no
timeout blocked 5002ms against a downstream that hung for 5000ms) shows
exactly what happens to the *order-creation* request if the notification
call is inline and the provider is slow: the customer's order fails or
hangs because a text message could not be sent. Decoupling via the
outbox lets the business transaction commit on its own, and lets the
notification pipeline retry and degrade independently.

## Interview questions

- Why does the outbox row get written in the *same* transaction as the
  business event, rather than published to a queue directly from the
  request handler?
- A worker claims an outbox event, calls the provider, the provider
  genuinely sends the SMS, and the worker crashes before marking the
  event published. What happens, and what two different mechanisms could
  prevent the user from receiving it twice?
- Why is a circuit breaker's outermost position (around retry, around
  timeout) important specifically for a *shared worker pool* draining
  many different users' notifications, not just for one call in
  isolation?
- A stakeholder asks why the platform doesn't use a message broker like
  Kafka instead of a Postgres-backed outbox. Under what concrete
  conditions would that tradeoff flip in the broker's favor?
- How would you distinguish, from your observability data alone, between
  "the notification provider is down" and "our own workers are
  under-provisioned"?
