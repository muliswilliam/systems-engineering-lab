# Drill 06 - Webhook delivery service

## Prompt

Design a webhook delivery service: internal business events must be
delivered as HTTP callbacks to third-party subscriber endpoints, each
subscriber configuring their own URL. Subscriber endpoints are entirely
outside your control - some are fast and reliable, some are slow, some
are broken and return errors or hang for a long time, some go offline for
hours. One bad subscriber must never degrade delivery to every other
subscriber, and delivery must survive worker crashes without an
unbounded retry storm.

Do your own prediction before reading on.

## Model answer

### 1. Invariants

- Every event that should be delivered to a subscriber is attempted
  at-least-once, and this is durable across worker crashes.
- Delivery attempts to one badly-behaving subscriber never consume
  resources (worker time, retry budget) that would otherwise go to other
  subscribers' deliveries.
- A subscriber that is down for an extended period eventually reaches a
  terminal, alertable state (not infinite retries), while a subscriber
  that recovers resumes receiving new events promptly.

### 2. Consistency requirements

The delivery-attempt record is **strongly consistent** with the
triggering event (an event's existence must durably imply a delivery
attempt will be made). Actual delivery is **at-least-once**, and this
design states explicitly, rather than assumes, that subscribers must
treat delivery as idempotent on their own end (a documented API contract
requirement, not something the sender alone can guarantee) - the same
"exactly-once is composed across boundaries, not a property of one side"
lesson Lab 19 teaches directly.

### 3. Storage choice

Postgres for `webhook_events` (the outbox-shaped record of what needs
delivering) and a `delivery_attempts` table, one row per (event,
subscriber, attempt) - the same durable-claim-and-lease shape Labs
14/17 both use, fanned out per subscriber rather than per generic worker
pool slot.

### 4. Concurrency mechanism

**Fan-out and claiming**: `SELECT ... FOR UPDATE SKIP LOCKED`, exactly
Lab 14's job-queue mechanism (and Lab 17's outbox-specific application of
it) - delivery attempts are claimable rows, and multiple delivery workers
scale horizontally the same way Lab 14 measured (50 workers over 250
claimable rows resolving in 125ms with zero double-claims).

**Isolating one bad subscriber from every other subscriber - the central
design decision of this drill**: a *per-subscriber* circuit breaker, not
one shared breaker or one shared retry budget for the whole service. Lab
37's retry-storm evidence is the direct argument for why a shared,
un-isolated retry policy is dangerous here specifically: 50 concurrent
callers retrying up to 5 times each against a single fully-down
downstream produced exactly 250 real calls and zero successes in Lab
37's own measurement - in a multi-tenant webhook service, "50 concurrent
callers" is not a stress-test artifact, it is what happens naturally when
one subscriber goes down while events keep arriving for them. A
per-subscriber breaker (Lab 37's own closed/open/half-open state machine,
measured tripping after exactly 5 consecutive failures and then costing
0ms per further call instead of 19-28ms of a real attempted call) confines
that cost to deliveries aimed at the down subscriber; deliveries to every
healthy subscriber proceed through their own, independent breaker
unaffected.

**Per-attempt timeout**: `withTimeout`, Lab 37's own pattern - a hanging
subscriber endpoint (explicitly named as a real category in this
prompt) is exactly Lab 37's naive-hang scenario (a caller with no
timeout blocked 5002ms against a downstream that hung for 5000ms); a
200ms-scale timeout bounds a delivery worker's worst-case time spent per
attempt regardless of how badly a subscriber's endpoint misbehaves.

**Backoff between retries to a struggling-but-not-yet-tripped
subscriber**: exponential backoff with full jitter, Lab 37's measured
pattern (delays like 7.3ms, 140.7ms, 361.1ms across 3 attempts against a
ceiling doubling 100->200->400ms) - jitter specifically prevents many
queued events for the same recovering subscriber from retrying in
lockstep and re-overwhelming it the moment it comes back.

**Terminal failure and dead-lettering**: `attempts`/`max_attempts` moving
a delivery to a terminal `failed`/dead-letter status, Lab 14's own
pattern - the mechanism that turns "subscriber down for hours" into a
bounded number of attempts plus an alertable terminal state, rather than
retries that never stop.

**Protecting the subscriber from the platform's own volume, independent
of failures**: a per-subscriber token-bucket rate limiter (Lab 36) so a
sudden burst of triggering events does not itself overwhelm a subscriber
that is otherwise healthy and would have handled a smoothed-out rate
fine.

**Receiver-side duplicate handling**: because delivery is at-least-once
(the same limitation Lab 17 proved `SKIP LOCKED` does not eliminate -
`brokerCallCount: 2` for one logical event after a crashed worker), every
delivered payload carries a stable event ID, and this design's public API
contract requires subscribers to dedupe on it - the same idempotent-
consumer discipline Lab 18's inbox pattern demonstrates on the receiving
side, just applied to a third party's system rather than this platform's
own.

### 5. Failure modes

- **One subscriber's endpoint is completely down for hours**: its
  per-subscriber circuit breaker trips, bounding wasted attempts to
  near-zero cost once OPEN; its deliveries accumulate as `failed`/dead-
  lettered after `max_attempts`, generating an alert, while every other
  subscriber's delivery pipeline is entirely unaffected.
- **A delivery worker crashes mid-attempt after the subscriber actually
  received the HTTP call**: the lease expires, another worker reclaims
  and redelivers - a real duplicate delivery the receiving subscriber is
  contractually expected to dedupe on the event ID, per the invariant
  above.
- **A burst of triggering events for one subscriber exceeds what their
  endpoint can handle even though it is healthy**: the per-subscriber
  rate limiter smooths it, independent of the circuit breaker (the
  limiter reacts to *volume*, the breaker reacts to *failure*).
- **The platform's own delivery-worker pool is under-provisioned relative
  to total subscriber volume**: visible as a growing pending-delivery
  count with breakers mostly CLOSED (subscribers are fine, the platform
  itself is the bottleneck) - a different signal from a growing count
  with breakers OPEN (subscribers, not the platform, are the problem).

### 6. Scale estimate

Thousands of subscribers, each independently claimable via `SKIP LOCKED`
and each with its own breaker state - this is the same horizontally-
scaling worker-pool shape Lab 14/17 measured (adding workers reduces
drain time roughly linearly, with a losing claim costing ~10ms rather
than a blocking ~312ms). The design specifically avoids anything that
would require a global lock or coordinator per subscriber, since that
would reintroduce a single point of contention across a workload that is,
by nature, embarrassingly parallel across independent subscribers.

### 7. Observability

- Per-subscriber circuit breaker state, dead-letter count, and delivery
  latency histogram - a subscriber-scoped dashboard, since the whole
  point of the design is subscriber isolation and the observability
  needs to reflect that same granularity.
- Delivery-attempt structured logs correlated by event ID across claim,
  attempt, and outcome (Lab 38's correlation-ID pattern).
- Aggregate pending-delivery count *and* per-subscriber pending count,
  since an aggregate number alone cannot distinguish "one subscriber is
  down" from "the platform is generally behind."

## Common wrong answer

**"Retry every failed delivery immediately, forever, until it succeeds -
webhooks should always eventually get through."** This is the wrong
answer this drill is specifically built around, and Lab 37 has the exact
measured evidence against it: immediate, unbounded, no-backoff retries
against a downstream that is genuinely down do not increase eventual
delivery odds, they multiply load for zero benefit (Lab 37's own 50
concurrent callers x 5 retries = 250 real calls, 0 successes) - in a
webhook platform, this pattern also means one down subscriber's retry
volume can starve worker capacity that other subscribers need, and there
is no terminal state, so a permanently-dead subscriber endpoint (a
company that closed, a URL that was never valid) queues deliveries
forever. The correct shape is bounded retries with backoff and jitter,
a circuit breaker to stop attempting a structurally-down subscriber
immediately rather than after a slow timeout each time, and an explicit
terminal failed/dead-letter state with alerting.

## Interview questions

- Why is the circuit breaker scoped per-subscriber rather than one
  breaker for the whole delivery service?
- A subscriber's endpoint returns HTTP 200 but never actually processes
  the payload (a bug on their end). What does this design's mechanisms
  catch, and what do they not catch - who is responsible for the gap?
- Compare this design's `SKIP LOCKED` claiming to a naive "for each
  subscriber, spawn a dedicated always-running worker thread." What
  breaks about the naive approach at 10,000 subscribers, most of them
  receiving events rarely?
- Why must the webhook payload include a stable, subscriber-visible
  event ID, and what happens to subscribers who ignore it?
- If a subscriber's breaker has been OPEN for 48 hours, what would you
  want your on-call runbook to say, and what evidence would justify
  manually closing it early versus waiting for it to recover on its own?
