# Drill 03 - Payment API

## Prompt

Design a payment-processing API that must never double-charge a customer,
even if the network fails mid-request, the client retries, or a downstream
processor's response is lost. Charges must also update an internal ledger
and notify other services (fraud, accounting) without those services'
downtime affecting whether the charge itself succeeds.

Do your own prediction before reading on.

## Model answer

### 1. Invariants

- For one logical charge request (identified by a client-supplied
  idempotency key, not a client-generated new request), at most one
  charge is ever applied - regardless of how many times the HTTP request
  is retried.
- A charge that debits the internal ledger and a charge that notifies
  downstream systems either both eventually happen, or the ledger write
  is what is authoritative if they disagree (the ledger write must never
  be silently skipped because a downstream notification failed).
- A retry never returns a *different* result than the original attempt
  for the same idempotency key - not just "doesn't double charge," but
  "returns the same confirmation code."

### 2. Consistency requirements

**Strong** for the charge-and-ledger-write itself - this is a financial
mutation and must be atomic and durable before the API responds success.
**At-least-once, receiver-idempotent** for downstream notification
(fraud, accounting) - those systems do not need to be up, or fast, for
the charge itself to succeed, per Lab 16's entire premise (the write and
the notification-trigger must not be a distributed dual write).

### 3. Storage choice

Postgres. The ledger and the idempotency record share a database and,
critically, share a transaction - this is the same reasoning Lab 05 uses
for a money transfer (two dependent writes must commit or roll back
together) extended with Lab 15's idempotency-key mechanism.

### 4. Concurrency mechanism

**Idempotent charge**: `INSERT ... ON CONFLICT (idempotency_key) DO
NOTHING RETURNING *` plus a fallback `SELECT` on conflict, exactly Lab
15's pattern - Lab 15 measured 10 concurrent requests carrying the *same*
key producing exactly 1 persisted row, with every one of the 10 callers
receiving the identical response, including for values that are
non-deterministic to compute (Lab 15's confirmation-code example) but
must be deterministic to *return*. Lab 15 also reproduced the failure
mode this drill exists to prevent directly: 10 concurrent retries that
each generate a *fresh* key (client bug, or a naive "generate a new
request ID per attempt" retry policy) still produced 10 separate rows
even with a real `UNIQUE` constraint present - the constraint only helps
if the client (or an API gateway acting on the client's behalf) reuses
the same key across retries of the *same* logical request.

**The retry-across-a-lost-response race, specifically**: Lab 37 built
this exact bug, distinct from Lab 15's plain-duplicate-request case - a
downstream `charge()` call commits its effect immediately but delays its
*response* 400-900ms, so a client with a shorter timeout (Lab 37 used
150ms) can observe a timeout for a call that has already succeeded
server-side. Lab 37's naive retry (regenerating the request instead of
reusing an idempotency key) produced a real captured ledger total of
2000 cents (2 applied charges) for one intended 1000-cent charge; reusing
the same idempotency key across the retry kept the ledger at exactly
1000 cents / 1 charge, with the retry's returned charge ID proven
identical to the original's. This is the direct evidence for why "the
client observed a timeout" must never be treated as "the operation did
not happen."

**Cross-row invariant during the charge** (e.g. "the source account's
balance must never go negative," a check spanning the account row and
the ledger-entry insert): if this is enforced as a cross-row invariant
rather than a single-row `CHECK` (e.g. balance is derived by summing
ledger entries rather than stored denormalized), it is exactly Lab 09's
Serializable-plus-bounded-retry shape - both a concurrent charge and a
concurrent refund on the same account are the same class of anomaly as
Lab 09's on-call-staff write skew, and Repeatable Read alone would let
both commit and silently violate the balance invariant.

**Decoupling the charge from downstream notification**: the transactional
outbox pattern, Lab 16's exact mechanism (`BEGIN; INSERT charge; INSERT
outbox_event; COMMIT`) - Lab 16 demonstrated the alternative (a naive
dual write) failing in both directions with real captured evidence: the
DB commits and a simulated broker publish fails, leaving zero recoverable
event rows to notify fraud/accounting from; or the broker "succeeds" and
the DB write is then rejected (a real `CHECK` violation, `SQLSTATE
23514`), leaving the broker believing a charge happened that never did.
Publisher workers drain the outbox via `SELECT ... FOR UPDATE SKIP
LOCKED` (Lab 17's pattern, measured at 10 workers draining 30 events with
zero double-claims in 30ms) - and Lab 17's own crashed-publisher
demonstration is directly relevant here: a worker can claim an event,
have the downstream genuinely receive it, then crash before recording
that fact, and a second worker reclaims and re-delivers it (Lab 17's own
captured `brokerCallCount: 2` for one logical event). That means fraud
and accounting, as *consumers* of this outbox, must themselves be
idempotent - the inbox pattern, Lab 18's `INSERT ... ON CONFLICT
(message_id) DO NOTHING` plus the business effect inside one transaction,
verified exactly-once under both sequential and 10-20-way concurrent
redelivery in Lab 18's own tests.

### 5. Failure modes

- **Client retries after a network failure with no response received at
  all**: covered by the idempotency key, provided the client (or an
  idempotency-aware API gateway sitting in front of this service) reuses
  the same key - this is a client-contract requirement this design must
  document explicitly, not something the server can enforce unilaterally
  if the client generates a fresh key every time.
- **Downstream payment processor is slow or down mid-charge**: Lab 37's
  full composition (circuit breaker outermost, retry-with-jittered-
  backoff inside it, per-attempt timeout innermost) bounds the caller's
  worst-case wait and stops hammering a processor that is structurally
  down, rather than the naive retry-storm shape Lab 37 measured directly
  (50 concurrent callers x 5 retries against a fully-down downstream
  produced exactly 250 real calls and zero successes - 5x the load for
  0% of the benefit).
- **A publisher worker crashes after the downstream broker/notification
  genuinely received the event**: not preventable by `SKIP LOCKED` alone
  (Lab 17's own honest limitation - `brokerCallCount: 2`); the fix lives
  on the *consumer* side (Lab 18's inbox pattern), which this design
  requires of fraud/accounting explicitly rather than assuming the
  outbox alone solves it.
- **Two concurrent operations on the same account violate a cross-row
  balance invariant**: Serializable's `SQLSTATE 40001` plus bounded
  retry (Lab 09) turns an otherwise-silent violation into a detected,
  retried failure.

### 6. Scale estimate

The idempotency check itself is a single indexed `UNIQUE` lookup/insert -
cheap and does not degrade under concurrent load on *different* keys;
Lab 15's own 10-concurrent-same-key benchmark shows the mechanism
correctly serializing exactly the contended case (same key) while
leaving every other key's throughput unaffected. Outbox publishing scales
by adding more `SKIP LOCKED` workers, the same linear-with-worker-count
behavior Lab 14/17 both measured directly (50 workers/250 jobs resolved
in 125ms with zero double-claims in Lab 14's numbers).

### 7. Observability

- Idempotency-key hit rate (fraction of requests that resolved via the
  `ON CONFLICT` branch rather than a fresh insert) - a rising rate during
  an incident is a strong signal of client-side retry behavior, not
  necessarily a system problem.
- Outbox lag (age of the oldest un-published event) and circuit breaker
  state for the downstream processor and for fraud/accounting delivery,
  per Lab 40's own `notificationCallsMade`/`circuitOpenRejections`
  counters.
- A dedup-hit counter on the consumer side (Lab 18's `duplicateCount`
  metric shape) - a nonzero, expected number under normal at-least-once
  delivery, not itself an error.

## Common wrong answer

**"Hold a per-customer lock (in-process, or a Redis lock) for the
duration of the payment call, so a retry can't run concurrently with the
original request."** This does not solve the stated problem. The failure
this drill is about is not two *concurrent* requests racing - it is the
*same logical request being executed twice, sequentially*, because the
client (reasonably) cannot tell whether its first attempt succeeded. A
lock released at the end of the first (successful) call does nothing to
stop a second, later call from proceeding and charging again; locks
solve mutual exclusion between concurrent actors, not "remember that this
exact request already happened," which is what an idempotency key is
for. This is exactly the distinction SPEC.md's own "Learning Philosophy"
section states directly: "A reservation is a business state. A lock is a
concurrency mechanism" - generalized here to "an idempotency key durably
records a completed request; a lock only durably records who currently
holds it." The correct mechanism needs to survive across separate HTTP
calls and process restarts, which an in-request lock, by construction,
cannot do.

## Interview questions

- Why must the retry reuse the *same* idempotency key rather than the
  client simply checking "did my last request succeed" before deciding
  whether to retry? What real failure mode from Lab 37 makes that
  checking approach unreliable?
- The outbox publisher can deliver the same event twice. Why doesn't this
  violate the "never double-charge" invariant, given that the charge and
  the outbox event are written in the same transaction?
- A teammate argues Kafka's "exactly-once semantics" configuration makes
  the consumer-side inbox pattern unnecessary. What would you check
  before agreeing, and which lab's core lesson does this connect to?
- Why is the idempotency check placed on a `UNIQUE` constraint in
  Postgres rather than a preliminary `SELECT ... WHERE idempotency_key =
  ?` followed by an `INSERT` if nothing was found?
- If the payment processor call itself needs to reach a cross-row balance
  invariant, why is Serializable isolation scoped to just that check
  rather than wrapping the entire charge-plus-outbox transaction?
