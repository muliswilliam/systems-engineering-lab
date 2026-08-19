# Lab 17 - Outbox Workers with `SKIP LOCKED`

## Why this exists

Lab 16 (transactional outbox - built independently, not imported here per the
independent-labs principle) solves the dual-write problem on the WRITE side:
`BEGIN / INSERT order / INSERT outbox_event / COMMIT` guarantees the business
write and the "I need to publish this" record become durable together. It
says nothing about the READ side - some process still has to notice pending
`outbox_event` rows, publish them to a broker, and mark them done. If two
publisher processes run for throughput or availability, they must not both
grab the same row (wasted broker calls, and worse, ambiguous bookkeeping
about who "owns" it right now). Lab 14 solved exactly this shape of problem
for a generic job queue using `SELECT ... FOR UPDATE SKIP LOCKED` - this lab
rebuilds that same claim mechanism, independently, against an outbox-shaped
table, and then pushes past it to the question the claim mechanism cannot
answer: once a worker has safely claimed an event and told the broker about
it, what happens if the worker dies before it can record that fact? The
answer is uncomfortable and important: **the broker gets called again, by a
different worker, for the same logical event** - even though the claiming
was never unsafe. Per CLAUDE.md's explicit instruction, this lab does not
pretend otherwise: it proves the duplicate really happens, and then shows the
only real fix - a consumer that can tell "I already did this" - as a preview
of Lab 18.

## Learning objectives

After this lab you should be able to:

- write a `SELECT ... FOR UPDATE SKIP LOCKED` claim query that treats both
  "never touched" (`pending`) and "abandoned lease" (`processing` with an
  expired `locked_until`) rows as claimable in one `WHERE` clause;
- explain why `SKIP LOCKED` makes concurrent claiming safe (no two workers
  ever hold the same row) while explaining, separately and precisely, why
  that says nothing about how many times an external side effect (a broker
  call) happens for that row;
- reproduce, on a real running Postgres instance, a worker "crashing" after
  a broker call genuinely succeeds but before the database is updated to
  reflect it - and prove with a real call counter that the broker was
  invoked twice for the same event;
- explain why this is not a claiming bug and cannot be fixed by claiming
  harder (a bigger lease, a stricter lock, a longer transaction) - the gap is
  structural: the broker call and the database write recording it can never
  be the same atomic operation, because the broker is not part of Postgres;
- implement a minimal, Postgres-native idempotent-consumer check
  (`INSERT ... ON CONFLICT DO NOTHING` against a unique `public_id`) and show
  it turns a real duplicate delivery into a harmless one - and explain
  exactly what a *complete* version of that mechanism (Lab 18) would still
  need to add.

## Architecture

```text
outbox_events (id, public_id, event_type, payload jsonb,
               status: pending -> processing -> published | failed,
               locked_by, locked_until, attempts, max_attempts, published_at)

processed_events (id, event_public_id UNIQUE, processed_at)
   -- PREVIEW of Lab 18's inbox table only - see "Fix it" below.
```

```text
        pending
           │
           │ claim (SELECT ... FOR UPDATE SKIP LOCKED, same tx as UPDATE)
           ▼
       processing ──(lease expires, unpublished)──> reclaimed by ANY worker
           │
           │ broker.publish() succeeds
           ▼
   ┌───────────────────────┐
   │ gap: broker call ALREADY succeeded, but the UPDATE that would record
   │ that fact has not run yet. If the process dies here, this gap is
   │ exactly what the crashed-publisher scenario exploits.
   └───────────────────────┘
           │
           │ UPDATE ... SET status='published' (may never run)
           ▼
       published (terminal)
```

Domain: this lab does not model the write side that produces these rows (a
real `orders` table plus `BEGIN / INSERT order / INSERT outbox_event /
COMMIT` is Lab 16's job) - `outbox_events` is seeded directly with realistic
order-lifecycle event types (`OrderCreated`, `PaymentCaptured`,
`OrderShipped`, `InventoryAdjusted`, `RefundIssued`), as if some other,
already-correct process had already written them. This keeps the entire lab
focused on the PUBLISHING side. See `packages/data-generators/src/outbox.ts`.

```text
src/queue/broker.ts               <- simulated in-process broker (records every call)
src/queue/claim-and-publish.ts    <- claim (SKIP LOCKED) + publish + finalize
src/queue/idempotent-consumer.ts  <- Lab 18 PREVIEW: ON CONFLICT DO NOTHING dedup
src/scenarios/parallel-publishers.ts               <- N workers draining M events
src/scenarios/crashed-publisher-duplicate-delivery.ts <- THE key demonstration
src/scenarios/idempotent-consumer-preview.ts       <- same interleaving, harmless
```

The claim transaction (`BEGIN` / `SELECT ... FOR UPDATE SKIP LOCKED` /
`UPDATE ... SET status='processing'` / `COMMIT`) uses raw `pg` SQL, not
Drizzle's query builder - per CLAUDE.md's "ORM plus SQL" principle, this is
exactly the kind of Postgres-specific mechanism that should be visible as
real SQL. Schema and migrations still use Drizzle.

**Scoping decision - why a simulated broker, not a real one:** CLAUDE.md's
"Technology Defaults" says to only introduce infrastructure a lab actually
needs. This lab's lesson is entirely about the CLAIM (SKIP LOCKED) and the
gap between "broker call succeeded" and "we recorded that fact" - a real
broker (Kafka/SQS/RabbitMQ) would add topic/connection/ack machinery that
doesn't change that lesson and would make the duplicate harder to observe
deterministically, not easier. `src/queue/broker.ts`'s `createSimulatedBroker`
is an in-process function that records every call it received, configurable
to succeed, fail, or run slowly - sufficient to prove `publishToBroker` was
called twice for one event.

## Setup

```bash
pnpm install
cp labs/17-outbox-workers-skip-locked/.env.example labs/17-outbox-workers-skip-locked/.env
cd labs/17-outbox-workers-skip-locked
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate
pnpm seed --seed=42 --size=small   # 30 pending outbox events, deterministic
```

Open PGweb at http://localhost:8417 (auto-connects via `PGWEB_DATABASE_URL`).
You should see 30 `pending` rows in `outbox_events` and an empty
`processed_events` table until you run a scenario.

## Scenario

An upstream service has already written 30 outbox events representing order
lifecycle activity (`OrderCreated`, `PaymentCaptured`, `OrderShipped`, ...).
Some number of publisher worker processes need to drain this table: claim an
event, hand it to a message broker, and mark it done. The one invariant that
must hold no matter how many workers run concurrently is:

> No event is ever claimed by two workers at the same time.

That invariant is exactly what `SKIP LOCKED` protects. This lab then asks a
second, harder question the first invariant does not answer:

> Is a claimed-and-published event ever handed to the broker more than once?

## Prediction

Before running anything, predict:

1. With 10 workers racing to drain 30 pending events, does every event get
   claimed by exactly one worker, or can two workers ever end up processing
   the same row?
2. A worker claims an event, successfully calls the broker, and then the
   process dies before running the `UPDATE ... SET status='published'`. Does
   the event stay stuck at `processing` forever, or does something eventually
   notice and act on it?
3. If a second worker eventually reclaims that same event and calls the
   broker again, does that mean the SKIP LOCKED claim mechanism failed?
4. Can a consumer make the duplicate broker call harmless without changing
   anything about how the outbox claims or publishes?

## Exercise

1. Run the setup commands above.
2. Run the parallel-publishers drain:
   ```bash
   pnpm scenario:parallel-publishers
   ```
3. Reseed, then run the crashed-publisher demonstration:
   ```bash
   pnpm seed --seed=42 --size=small
   pnpm scenario:crashed-publisher
   ```
4. Reseed again, then run the idempotent-consumer preview over the identical
   interleaving:
   ```bash
   pnpm seed --seed=42 --size=small
   pnpm scenario:idempotent-preview
   ```
5. Run `pnpm test` and read through `tests/integration/` - every number
   above is also a real automated assertion, not just narrated log output.

## Observe

- **PGweb** (http://localhost:8417): watch `outbox_events.status` transition
  `pending -> processing -> published` and `outbox_events.locked_by` /
  `locked_until` populate and clear.
- **`docker compose logs postgres`**: `log_statement=all` shows every literal
  `BEGIN`, `SELECT ... FOR UPDATE SKIP LOCKED`, `UPDATE`, and `COMMIT` -
  compare the claim transaction's two statements against the separate,
  later `UPDATE ... SET status='published'` outside any transaction.
- **Structured logs**: every worker log line includes a `workerId` field
  (`@labs/logging`/Pino, per CLAUDE.md's logging standard) - grep
  `docker compose logs` or the script output by `workerId` to follow one
  worker's whole lifecycle.
- **`SELECT id, status, locked_by, locked_until, attempts FROM outbox_events
  WHERE status = 'processing' AND locked_until < now();`**: in production,
  this is exactly the query an on-call engineer or a monitoring job would run
  to find abandoned claims - a nonzero, growing count here means publishers
  are crashing faster than they're draining.
- **`SELECT * FROM processed_events;`**: after the idempotent-preview
  scenario, exactly one row per event `public_id`, despite two broker
  deliveries.

## Break it

Run:

```bash
pnpm scenario:parallel-publishers
```

Real captured output from this lab's own validation run (seed 42,
`--size=small`, 30 pending events, 10 workers):

```text
parallel publisher drain complete
  workerCount: 10          pendingCount: 30
  totalClaimed: 30         uniqueEventsClaimed: 30
  noDoubleClaims: true
  claimsByWorker: { worker-0: 4, worker-1: 3, worker-2: 3, worker-3: 3,
                     worker-4: 2, worker-5: 3, worker-6: 3, worker-7: 3,
                     worker-8: 3, worker-9: 3 }
  wallClockMs: 30
  brokerTotalCalls: 30
  statusCounts: [{ status: "published", count: "30" }]
```

At `--size=medium` (300 events), the same 10 workers still drain every event
exactly once, more evenly (each worker claims 29-31), in 119ms wall clock -
`noDoubleClaims: true` held at both scales. So far, this is the SAFE case:
`SKIP LOCKED` is doing exactly its job.

Now reseed and run the crashed-publisher demonstration - THE key experiment
in this lab:

```bash
pnpm seed --seed=42 --size=small
pnpm scenario:crashed-publisher
```

Real captured output:

```text
worker A published successfully, then simulated a crash before finalizing
  workerId: "worker-crash-a"   eventId: 670   attempt: 1

worker B reclaimed the lease-expired event and published it (again)
  workerId: "worker-crash-b"   eventId: 670   attempt: 2

DUPLICATE DELIVERY CONFIRMED: publishToBroker was called more than once for
the same event, even though the claim was never held by two workers at once
  eventId: 670
  eventPublicId: "3eea983c-eb77-4cd3-bf04-4bbf956e4414"
  brokerCallCount: 2
  workerAAttempt: 1        workerBAttempt: 2
  finalStatus: "published" finalAttempts: 2
```

`brokerCallCount: 2`. The broker really was told about this exact event
twice. Walk through why:

1. Worker A's claim transaction commits (`attempts` goes from 0 to 1,
   `status='processing'`, `locked_until` set 500ms out). This claim was
   completely safe - no other worker could have raced it.
2. Worker A calls the broker. It genuinely succeeds - `broker.deliveries`
   really has this event in it now, exactly as it would in a real system
   where the message genuinely reached a real queue.
3. Worker A "crashes" (the scenario calls `claimAndPublish` with
   `skipFinalize: true`) - the `UPDATE ... SET status='published'` never
   runs. Nothing rolled anything back, because there was nothing to roll
   back: the claim transaction already committed, and the broker call is not
   a database operation at all.
4. Once `locked_until` is in the past, worker B's claim query
   (`status = 'processing' AND locked_until < now()`) finds the exact same
   row and reclaims it (`attempts` goes to 2) - just as safely as worker A's
   original claim.
5. Worker B, correctly following the same protocol, calls the broker again.
   It also succeeds. `publishToBroker` has now run twice for one logical
   event.

## Fix it

There is no fix that makes the CLAIM safer here - it already is. Making the
lease shorter, the transaction stricter, or the lock stronger cannot close
this gap, because the gap is not inside Postgres: it is the interval between
"the broker call returned success" (a fact that exists only in the crashed
worker's now-dead process memory, or in the broker's own state) and "a
database row says so" (a fact Postgres can make durable). No amount of
locking discipline on the CLAIM can make an external network call and a
database write atomic with each other.

What actually helps is moving the responsibility to the other side of the
call: the CONSUMER remembers which events it already applied, and skips
duplicates. `src/queue/idempotent-consumer.ts`'s `consumeIdempotently` is a
minimal, Postgres-native preview of this - `INSERT INTO processed_events
(event_public_id) VALUES ($1) ON CONFLICT (event_public_id) DO NOTHING
RETURNING id`, using Postgres's own UNIQUE constraint instead of an
application-level check-then-insert (which would have exactly the same race
a claim without `SKIP LOCKED` would).

Run the identical crashed-publisher interleaving with the dedup check in
place:

```bash
pnpm seed --seed=42 --size=small
pnpm scenario:idempotent-preview
```

Real captured output:

```text
worker A published successfully, applied the consumer side effect, then
simulated a crash before finalizing
  workerId: "worker-preview-a"   duplicate: false

worker B reclaimed and published (again), but the consumer recognized the
duplicate and skipped the side effect
  workerId: "worker-preview-b"   duplicate: true

HARMLESS DUPLICATE: publishToBroker was still called twice, but the
idempotent consumer applied the side effect exactly once
  brokerCallCount: 2
  sideEffectApplications: 1
  finalStatus: "published"
```

`brokerCallCount` is still `2` - the duplicate delivery genuinely still
happens, exactly as before. But `sideEffectApplications` is `1`: the second
`consumeIdempotently` call found `processed_events.event_public_id` already
present (the UNIQUE constraint's `ON CONFLICT DO NOTHING` made the INSERT a
no-op) and skipped applying the business-logic side effect a second time.

`pnpm test` captures all four of the above as real assertions:

```text
✓ tests/integration/parallel-publishers.test.ts (2 tests)
✓ tests/integration/crashed-publisher-duplicate-delivery.test.ts (1 test)
✓ tests/integration/idempotent-consumer-preview.test.ts (1 test)

Test Files  3 passed (3)
     Tests  4 passed (4)
```

**This is deliberately a PREVIEW, not Lab 18.** `consumeIdempotently` and
`processed_events` do NOT cover (see the doc comment in
`src/queue/idempotent-consumer.ts` for the full list):

- retention/cleanup of `processed_events` (it grows without bound here);
- ordering guarantees across multiple concurrent consumers;
- what happens if the business-logic side effect itself fails *after* the
  `INSERT` into `processed_events` already committed (a real inbox needs
  the insert and the side effect in the same transaction, or its own outbox
  on the consumer's side - Lab 18's actual subject);
- retry/backoff semantics for the consumer itself.

## Why the fix works

`SKIP LOCKED`'s guarantee is precise and narrow: two workers can never hold a
row lock on the same claimable row at the same time, because
`FOR UPDATE SKIP LOCKED` makes a worker whose candidate row is already locked
skip it instead of waiting for it. Combined with the lease
(`locked_until`), this also guarantees a claim cannot be held forever by a
worker that silently died - eventually the row becomes claimable again by
anyone. Both of those are real, useful, datastore-native guarantees, and
this lab's `parallel-publishers` scenario proves them: 30-for-30 and
300-for-300 unique claims, zero double-claims, at two different scales.

Neither guarantee has anything to say about how many times a THIRD PARTY (the
broker) was told about the event. That is a fact about a network call to a
system outside Postgres's transaction boundary - Postgres can make "this row
says published" durable, but it cannot make "the broker was told" and "the
row says published" a single atomic fact, because the broker call happens
strictly outside of any Postgres transaction (see `src/queue/
claim-and-publish.ts`'s comment on `claimAndPublish` for why it is
deliberately NOT one big transaction spanning the broker call).

The idempotent-consumer preview works because it moves the "did this already
happen" check to a place that CAN be made atomic with a database write: the
consumer's own `INSERT ... ON CONFLICT DO NOTHING`. Postgres's UNIQUE
constraint is the datastore-native guarantee doing the real work here (per
CLAUDE.md's "prefer datastore-native guarantees" principle) - the same
principle Lab 11's conditional writes and this lab's own `SKIP LOCKED` claim
both lean on, applied here to deduplication instead of concurrency control.

## Tradeoffs

- **A longer lease reduces false reclaims but slows real recovery.** A
  publisher that is merely slow (not crashed) risks losing its claim to
  another worker if the lease is shorter than its actual processing time -
  see `playground/notes.md`'s experiment with a `slow` broker and a short
  lease, which reproduces the exact same duplicate-delivery pattern with NO
  crash involved at all. A longer lease makes that less likely but means a
  genuinely crashed worker's event sits unclaimed for longer.
- **`attempts` counts claims, not broker calls.** This lab's `attempts`
  column increments once per claim (including reclaims) - it is useful for
  bounding retries (`max_attempts` -> `failed`), but it is NOT the same
  number as how many times the broker was actually called, which is exactly
  the point: those two numbers can diverge, and this lab proves it.
- **The idempotent-consumer preview grows `processed_events` forever.** A
  real inbox needs a retention policy (e.g. delete rows older than the
  broker's own maximum redelivery window) - not built here, deliberately, to
  keep this lab's scope to the duplicate-delivery proof and the preview
  fix, not a full inbox implementation.
- **Moving the fix to the consumer means every consumer must implement it.**
  Unlike a producer-side fix (which would only need to be correct once),
  idempotent consumption is a requirement on every downstream service that
  reads this outbox - a org-wide messaging contract, not a one-time code
  change. This is exactly why Lab 18 exists as its own lab.

## Production notes

1. **What guarantee does this mechanism give?** `SKIP LOCKED` guarantees no
   two workers ever hold the same claim simultaneously, and a lease
   guarantees an abandoned claim eventually becomes reclaimable. This lab's
   tests assert both directly (no double claims across 30 and 300-event
   drains; a lease-expired claim is reclaimed and reaches `published`).
2. **What does it not guarantee?** Exactly-once delivery to the broker. This
   lab's `crashed-publisher-duplicate-delivery.test.ts` proves
   `brokerCallCount === 2` for a single logical event under a real,
   reproducible crash interleaving - not a theoretical caveat, a captured
   assertion.
3. **What breaks under process crash?** Before the broker call: nothing -
   the claim transaction either committed (row is `processing`, safely
   reclaimable after its lease) or didn't (row is untouched). After the
   broker call but before the finalize `UPDATE`: this lab's entire subject -
   the broker was told, the database doesn't know it yet, and a reclaim will
   tell the broker again.
4. **What changes at high contention?** More workers racing more claims
   means more `SKIP LOCKED` skips (cheap) instead of blocked waits (this
   lab's parallel-publishers scenario at 10 workers over 300 events, 119ms
   wall clock, shows this scales without lock contention becoming the
   bottleneck) - but it does NOT reduce the duplicate-delivery risk, which is
   about lease timing and crash timing, not concurrency level.
5. **What changes at larger scale?** More publisher instances mean more
   chances for exactly this crash-before-finalize window to occur in
   absolute terms, even though each individual occurrence is equally likely
   per worker. The fix does not change with scale - idempotent consumers are
   required at any scale where at-least-once delivery is possible, which is
   effectively always once you have more than one publisher process.
6. **What metrics would be monitored?** Count and age of `outbox_events` rows
   at `status = 'processing'` with `locked_until` in the past (abandoned
   claims awaiting reclaim); `attempts` distribution (a event needing many
   reclaims signals a chronically crashing or too-slow publisher); rate of
   `processed_events` conflicts on the consumer side (a direct, countable
   measure of how often duplicate delivery is actually happening in
   production, not just theoretically possible).
7. **When should this approach be avoided?** Never skip the lease/reclaim
   mechanism itself - without it, a single crashed publisher permanently
   stalls every event it happened to claim. But never rely on the claim
   mechanism ALONE as a substitute for consumer idempotency if the broker or
   any downstream consumer has an observable side effect (charging a card,
   sending an email) - that always needs its own dedup story, in this lab's
   preview form or Lab 18's fuller one.

## Interview questions

1. Why does `SELECT ... FOR UPDATE SKIP LOCKED` prevent two workers from
   claiming the same row, but not prevent the broker from being called twice
   for that row?
2. Could making the claim transaction span the broker call fix the duplicate
   delivery? Why or why not - what would that transaction actually be
   holding open, and for how long?
3. What is the difference between what `attempts` counts in this lab's
   schema and how many times `publishToBroker` was actually invoked? Why do
   they diverge?
4. Why does `consumeIdempotently` use `INSERT ... ON CONFLICT DO NOTHING`
   instead of `SELECT` to check for an existing row, followed by a
   conditional `INSERT`?
5. If a downstream consumer's business-logic side effect fails AFTER
   `processed_events` already recorded the event as processed, what happens
   on the next redelivery attempt - and why is that itself a real problem
   this lab's preview does not solve (a preview of what Lab 18 has to)?
6. A monitoring job flags a growing count of `outbox_events` rows stuck at
   `status = 'processing'` with an expired `locked_until`. What are the
   possible root causes, and how would you distinguish "publishers are
   crashing" from "publishers are just slower than the configured lease"?
7. Why can't a longer lease alone solve the duplicate-delivery problem, even
   though it does reduce false reclaims?

## Further experiments

- Change `crashed-publisher-duplicate-delivery.ts`'s broker to
  `{ mode: "slow", slowMs: 400 }` with a `leaseMs` of `200` in the
  parallel-publishers scenario (no crash at all) and confirm you can
  reproduce the same `brokerCallCount > 1` pattern purely from a lease
  shorter than the broker's own latency - see `playground/notes.md`.
- Increase `parallel-publishers.test.ts`'s worker count to 50 over a
  `--size=large` (3,000-event) seeded batch and confirm `noDoubleClaims`
  still holds and the drain still completes.
- Add a genuine broker-failure path: run the crashed-publisher demo with
  `createSimulatedBroker({ mode: "fail" })` on worker B's second attempt and
  watch `markPublishFailed` move the row toward `failed` once `attempts`
  reaches `max_attempts` instead of `published`.
- Try shortening `LEASE_MS` in `runCrashedPublisherDemo` to something very
  small (e.g. `50`) and see how much sooner the duplicate delivery occurs -
  confirm the duplicate is not a probabilistic race, it is guaranteed by the
  interleaving regardless of timing, as long as the lease expires before the
  finalize `UPDATE` runs.
- Extend `idempotent-consumer-preview.ts` to add a retention query
  (`DELETE FROM processed_events WHERE processed_at < now() - interval '7
  days'`) and think through what redelivery window that retention period
  needs to safely exceed.
