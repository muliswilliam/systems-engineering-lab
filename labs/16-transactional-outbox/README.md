# Lab 16 - Transactional Outbox

## Why this exists

Creating an order in a real system almost never means "write one row." It
usually also means "tell everyone else who cares" - billing, fulfillment,
analytics, a search index - by emitting an event such as `OrderCreated`. The
naive way to do that is to write the order row to Postgres, then separately
call out to a message broker (Kafka, RabbitMQ, SQS, a webhook, anything). That
"write to two different systems for one logical operation" shape is the
**dual-write problem**, and it fails in two directions that people rarely
think about symmetrically:

1. The database write commits, then the broker call fails (broker down,
   network blip, timeout). The order exists, but nothing ever tells any
   downstream system about it.
2. The broker call succeeds first, then the database write fails. The broker
   now believes an order exists that never actually got created - a phantom
   event a downstream consumer has to reconcile.

Neither direction is fixable by "just retry the broker call" or "just retry
the DB write," because the two systems have no shared transaction. This lab
reproduces both failure directions on a real Postgres instance, then fixes
the *write-atomicity* half of the problem with the transactional outbox
pattern: write the business row and a durable "this needs to be published"
row in the same database transaction, so they are never observed
independently of each other.

## Learning objectives

After this lab you should be able to:

- explain precisely why writing to a database and calling an external system
  (broker, webhook, another service) can never be made atomic across the two
  systems by any amount of retry logic alone;
- reproduce both directions of the dual-write bug - DB-succeeds-broker-fails
  and broker-succeeds-DB-fails - and state exactly what corrupted state each
  one leaves behind;
- implement `BEGIN; INSERT order; INSERT outbox_event; COMMIT` and explain
  why it guarantees the order row and the outbox event row can never exist
  independently of each other;
- explain what the outbox pattern does NOT guarantee: it says nothing about
  whether publishing ever happens, whether it happens exactly once, or how
  fast it happens - it only fixes the atomicity of *recording the intent* to
  publish;
- read `outbox_events WHERE published_at IS NULL` as the query a real
  publisher (Lab 17) would poll, and understand why this lab's own
  `drainOutbox` is a one-shot preview, not a production publisher.

## Architecture

```text
orders (id, public_id, customer_name, amount_cents CHECK > 0, created_at)
   ▲
   │ aggregate_id (FK)
   └── outbox_events (public_id, aggregate_type, aggregate_id, event_type,
                       payload jsonb, created_at, published_at NULL-able)
```

This is a fresh, deliberately minimal commerce-adjacent domain - **not**
SPEC.md 8.2's full "Commerce" model (customers, products, carts, orders,
order_lines, payments, shipments). `customer_name` is a plain string column
on `orders`, not a foreign key into a `customers` table, because no scenario
or test in this lab needs a customer entity - only an order and the outbox
event describing it. This mirrors the scoping decisions in Lab 06
(`counters`) and Lab 11 (`documents`): a rich relational model around the
mechanism being taught would only add noise. `orders`/`outbox_events` are
defined only in this lab's own schema (not shared or imported), per the
independent-labs principle.

`outbox_events.aggregate_id` is a real foreign key into `orders.id` here
because this lab only ever has one aggregate type (`'order'`, enforced by a
`CHECK`). A production outbox table serving many aggregate types generally
cannot carry a single FK like this, since the referenced table varies per
row - see "Tradeoffs" below.

Three scenario scripts, one broker stand-in, one preview publisher:

```text
src/scenarios/broker.ts                          <- simulated publishToBroker(), configurable success/failure
src/scenarios/naive-dual-write-broker-fails.ts   <- DB commits, broker publish fails
src/scenarios/naive-dual-write-db-fails.ts       <- broker publish succeeds, DB write fails
src/scenarios/transactional-outbox.ts            <- THE FIX: BEGIN; INSERT order; INSERT outbox_event; COMMIT
src/scenarios/query-utils.ts                     <- shared count/join queries used by scenarios and tests
src/scripts/drain-outbox.ts                      <- minimal one-shot "publish unpublished events" preview of Lab 17
```

A real message broker (Kafka, RabbitMQ, SQS, ...) is deliberately **out of
scope** for this lab. Per `CLAUDE.md`'s infrastructure-minimalism guidance, a
broker is only worth adding for messaging labs "where a real broker
materially improves the exercise" - that is Lab 17 (outbox workers with
`SKIP LOCKED`), which builds a real publisher process. This lab's subject is
the atomicity of the *write* path, which is fully reproducible against
`src/scenarios/broker.ts`'s in-process stand-in for "an unreliable network
call to a broker." `publishToBroker` resolves or rejects, on a short
simulated delay, with a configurable `failureMode` - nothing about it
pretends to be a specific broker product.

All three scenario scripts and the drain script use the raw `pg` `Pool`/
`Client` directly for `INSERT`/`BEGIN`/`COMMIT`/`ROLLBACK`, per `CLAUDE.md`'s
"ORM plus SQL" principle - explicit transaction-boundary control is exactly
the kind of thing that should be shown as real SQL. Schema definition and
migrations still use Drizzle.

## Setup

```bash
pnpm install
cp labs/16-transactional-outbox/.env.example labs/16-transactional-outbox/.env
cd labs/16-transactional-outbox
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate
pnpm seed --seed=42 --size=small   # 5 baseline orders, each with one already-published outbox event
```

Open PGweb at http://localhost:8416 (auto-connects via
`PGWEB_DATABASE_URL`). You should see 5 rows in `orders` and 5 rows in
`outbox_events`, all with `published_at` already set - a clean starting
point, distinct from the rows the scenario scripts create (which use unique
`customer_name` markers so they never collide with seed data).

## Scenario

A minimal order-creation flow: a customer places an order, and the system
must both durably record the order and durably record that an `OrderCreated`
event still needs to reach every downstream system that cares about new
orders. Two things must be true no matter what:

> If an order row exists, there must be a durable, queryable record that an
> `OrderCreated` event for it still needs to be published (until it actually
> has been).

> If no order row exists, no downstream system should ever be told one was
> created.

## Prediction

Before running anything, predict:

1. If the order INSERT commits and then the broker call throws, is there
   anything in the database, right now, that could tell a reconciliation job
   "this order was never announced"? What would you have to build to make
   that recoverable?
2. If the broker call succeeds first and then the order INSERT fails (say, a
   CHECK violation), does Postgres leave any trace of the attempted order
   that a later query could find?
3. If the order INSERT and the outbox INSERT happen inside the same
   transaction, and the *second* one fails, what happens to the *first* one,
   which by itself succeeded?
4. Does wrapping both inserts in one transaction guarantee the event is ever
   actually published? What exactly does it guarantee, and what does it not?

## Exercise

1. Run the setup commands above.
2. Run the naive scenario where the DB commits but the broker fails:
   ```bash
   pnpm scenario:naive-broker-fails
   ```
3. Run the naive scenario where the broker succeeds but the DB write fails:
   ```bash
   pnpm scenario:naive-db-fails
   ```
4. Run the transactional outbox fix - happy path, then a forced outbox
   INSERT failure:
   ```bash
   pnpm scenario:outbox
   ```
5. Run the minimal drain preview twice in a row and confirm the second run
   finds nothing left to publish:
   ```bash
   pnpm outbox:drain
   ```
6. Run `pnpm test` and read through `tests/integration/` - these assert the
   exact invariants described above as real, automated checks against a
   running Postgres instance.

## Observe

- **PGweb** (http://localhost:8416): after running all three scenario
  scripts, look at `orders` and `outbox_events` side by side - filter
  `outbox_events` by `published_at IS NULL` to see exactly what Lab 17's
  `SKIP LOCKED` publisher workers would poll on.
- **`docker compose logs postgres`**: `log_statement=all` makes every literal
  `INSERT`, `BEGIN`, and `COMMIT`/`ROLLBACK` visible - compare the naive
  scenarios (no `BEGIN` at all - each `INSERT` is its own autocommitted
  statement) against the transactional scenario's `BEGIN` ... `COMMIT` /
  `BEGIN` ... `ROLLBACK` pairs.
- **Structured logs**: every scenario script logs through `@labs/logging`
  (Pino) with the order id, broker outcome, and row counts on every attempt.
- **`SELECT * FROM outbox_events WHERE published_at IS NULL;`**: in
  production, this is the query a publisher (or an alerting job watching for
  events stuck unpublished past some age) would run.

## Break it

Run both naive scenarios:

```bash
pnpm scenario:naive-broker-fails
```

Real captured output from this lab's own validation run:

```text
--- naive dual write: DB commits, broker publish fails ---
CORRUPTED: the order is durable, but nothing durable says this order still
needs to be published - no reconciliation query can recover that fact from
this database alone
  orderId: 11
  orderExistsInDb: true
  brokerPublished: false
  brokerError: "simulated broker publish failure for order:11 (OrderCreated)"
  outboxEventsRecorded: 0
```

The order row is real and durable (`orderExistsInDb: true`). The broker call
threw, and nothing in this naive version ever touches `outbox_events` - there
is no row anywhere that says "order 11 still needs to be announced." A
downstream billing or fulfillment system that only learns about orders via
that event will simply never find out order 11 exists.

```bash
pnpm scenario:naive-db-fails
```

```text
--- naive dual write: broker publish succeeds, DB write fails ---
CORRUPTED: the broker believes an OrderCreated event was sent, but no order
row for it ever existed - a downstream consumer now has a phantom order to
reconcile
  brokerPublished: true
  orderCommitted: false
  dbErrorCode: "23514"
  dbErrorMessage: "new row for relation \"orders\" violates check constraint
    \"orders_amount_cents_positive\""
  orderRowsInDb: 0
```

The (simulated) broker call succeeded first. The order INSERT that followed
was rejected outright by the `orders_amount_cents_positive` CHECK constraint
(a real SQLSTATE `23514`, standing in for "the DB write failed for any
reason after the broker already accepted the publish" - a deadlock, a lost
connection, any other cause would land here identically). `orderRowsInDb: 0`
- the broker believes an order was created that never existed at all.

## Fix it

Run:

```bash
pnpm scenario:outbox
```

Real captured output, same validation run:

```text
--- 1. transactional outbox, happy path ---
COMMITTED: exactly one orders row and one outbox_events row, atomically,
visible in one join
  committed: true
  orderId: 13
  outboxEventId: 11
  joinedRows: [{
    orderId: 13,
    customerName: "Outbox Happy - 6179c203-f7c3-43bf-b726-ead1700561ff",
    amountCents: 3200,
    outboxEventId: 11,
    eventType: "OrderCreated",
    publishedAt: null
  }]

--- 2. transactional outbox, outbox INSERT forced to fail ---
ROLLED BACK: neither the order row nor the outbox event row exists - the
failed outbox INSERT rolled back the order INSERT too, even though the order
INSERT itself succeeded
  committed: false
  reason: "new row for relation \"outbox_events\" violates check constraint
    \"outbox_events_event_type_valid\""
  orderRowsInDb: 0
```

In case 1, both the order and its outbox event exist, atomically, joinable
in one query, with `publishedAt: null` - publishing has not happened, but the
*intent* to publish is now a durable, queryable fact.

In case 2, the outbox INSERT was forced to fail (an event type not in the
`outbox_events_event_type_valid` CHECK - simulating a bug or a downstream
constraint violation on the outbox row itself). The order INSERT that ran
*earlier in the same transaction* had already succeeded against Postgres,
but `ROLLBACK` undid it along with the failed outbox INSERT - `orderRowsInDb:
0`. Neither row survives.

Then run the minimal drain preview:

```bash
pnpm outbox:drain
```

```text
--- draining outbox_events WHERE published_at IS NULL ---
drain complete
  attempted: 1
  publishedIds: [11]
  failedIds: []

--- draining again immediately - should publish 0 events ---
confirmed: no already-published event was re-published
  attempted: 0
  publishedIds: []
  failedIds: []
```

`pnpm test` captures all of this as real assertions:

```text
✓ tests/integration/drain-outbox.test.ts (2 tests) 41ms
✓ tests/integration/transactional-outbox.test.ts (3 tests) 35ms
✓ tests/integration/naive-dual-write.test.ts (2 tests) 46ms

Test Files  3 passed (3)
     Tests  7 passed (7)
```

## Why the fix works

`BEGIN; INSERT order; INSERT outbox_event; COMMIT` puts both writes on the
same connection, inside the same transaction. Postgres does not make either
write durable or visible to any other connection until `COMMIT` succeeds -
if anything fails before that (a CHECK violation on the second INSERT, a
dropped connection, an application-level error), `ROLLBACK` undoes both
writes together, exactly as if neither had ever been attempted. This is the
identical mechanism Lab 05 used for a money transfer's debit/credit pair,
applied here to a business row and its outbox-intent row instead of two
account balances.

Once this is true, `outbox_events` becomes a trustworthy source of truth for
"what still needs to be published," completely decoupled from whether
publishing has actually happened: a row's mere existence with
`published_at IS NULL` means "the order that produced this event definitely
exists" (the FK and the shared transaction guarantee that), and "publishing
has not yet succeeded" (that is what `published_at` tracks). Neither of the
naive scenarios' corrupted states - a durable order with no way to recover
that it needs publishing, or a phantom published-but-nonexistent order - is
possible once the two writes are atomic with each other.

**This does not make publishing reliable.** The outbox pattern only fixes
the write side. Whether an event actually gets published, how many times,
and how fast are entirely separate concerns - see "Tradeoffs" and
"Production notes" below, and Labs 17-19.

## Tradeoffs

- **The outbox pattern does not publish anything by itself.** An
  `outbox_events` row sitting with `published_at IS NULL` forever (because no
  publisher ever runs) is just as broken, operationally, as the naive bug
  this lab demonstrates - the fix moves the reliability problem from "did the
  write happen atomically" (solved, in this lab) to "is something actually
  draining this table" (Lab 17's job, not this lab's).
- **This lab's `drainOutbox` is explicitly not a production publisher.** It
  has no `FOR UPDATE SKIP LOCKED`, no concurrency safety, and no crash
  recovery between "the simulated broker call succeeded" and "`published_at`
  got set" - running it twice concurrently against the same unpublished rows
  would double-publish some of them, and a crash in that exact window would
  cause the *real* worker (Lab 17) to publish the same event again on its
  next pass. That "at least once" delivery, and the idempotent-consumer
  pattern needed to tolerate it, is Lab 18's job.
- **A generic outbox usually cannot have a single `aggregate_id` foreign
  key.** This lab's schema gives `outbox_events.aggregate_id` a real FK into
  `orders.id`, which only works because this lab has exactly one aggregate
  type. A production outbox serving many aggregate types (orders, refunds,
  shipments, ...) generally leaves `aggregate_id` as a plain, unconstrained
  column and relies on `aggregate_type` + application logic to interpret it,
  because a single column cannot reference more than one table at once.
- **The outbox table is extra write volume on the primary.** Every business
  write that needs an event now costs one more row and one more index update
  inside the same transaction. For most systems this is negligible compared
  to the cost of a real dual-write bug; at very high write throughput it is
  worth measuring (see Lab 33 for the general query-tuning workflow).

## Production notes

1. **What guarantee does this mechanism give?** The business row and the
   outbox-intent row for it either both become durable together, or neither
   does. This lab's rollback test proves it directly: forcing the outbox
   INSERT to fail leaves zero rows in both `orders` and `outbox_events` for
   that attempt.
2. **What does it not guarantee?** That the event is ever published, that it
   is published exactly once, or that it is published quickly. Those are
   Lab 17 (a real `SKIP LOCKED` publisher), Lab 18 (idempotent consumers, for
   when at-least-once delivery inevitably produces a duplicate), and Lab 19
   (delivery semantics in general).
3. **What breaks under process crash?** Before `COMMIT`: nothing - the
   transaction rolls back and neither row exists, same as Lab 05. After
   `COMMIT`: both rows are durable regardless of what the application does
   next; if the *publisher* process crashes between publishing and marking
   `published_at`, the event is republished on the next drain (an
   at-least-once outcome, not a data-loss one).
4. **What changes at high contention?** This lab's transactions are two
   single-row inserts, held open for milliseconds - contention is not a
   concern here. Under many concurrent order-creations, the outbox table's
   own index maintenance and a real Lab-17-style publisher's row-locking
   become the relevant costs, not this lab's atomicity mechanism.
5. **What changes with multiple regions?** Not applicable yet - single
   Postgres node, no replicas (see Lab 24+). A cross-region outbox
   (publishing from a read replica's data, or coordinating multiple regional
   primaries) introduces replication-lag and ordering questions this lab
   does not cover.
6. **What metrics would be monitored?** Count and age of `outbox_events` rows
   with `published_at IS NULL` (should be near zero and low-latency if a
   publisher is healthy; growing and aging is exactly "the publisher stopped
   working" or "nothing is running it at all"), and publish success/failure
   rate from whatever process eventually replaces this lab's `drainOutbox`.
7. **When should this approach be avoided?** Never avoid the transactional
   write-atomicity half of this pattern when a business write must be
   announced to another system - there is no simpler way to avoid the
   dual-write bug for a single database. The pattern is unnecessary overhead
   only if the "event" can be derived later, on demand, by simply querying
   the business table directly (no separate notification needed at all).

## Interview questions

1. Why can no amount of retrying the broker call, by itself, fix the
   DB-succeeds-broker-fails direction of the dual-write problem?
2. Walk through exactly what happens, mechanically, when the outbox INSERT
   inside a transactional order-creation function fails after the order
   INSERT already succeeded on the same connection.
3. Does the transactional outbox pattern guarantee an event is published
   exactly once? If not, what does guarantee that, and where does it live?
4. Why does this lab's `outbox_events.aggregate_id` get away with being a
   real foreign key, when a production outbox serving many aggregate types
   usually cannot do the same?
5. What query would you run against `outbox_events` to detect that your
   publisher has stopped working, and what would "unhealthy" look like in
   that query's result?
6. If you inherited a codebase where "create order" wrote to Postgres and
   then called `kafka.publish()` directly in the same request handler, what
   would you check first to size the blast radius of the bug this lab
   demonstrates?

## Further experiments

- Move the injected outbox-insert failure to happen on the *order* INSERT
  instead (e.g. a negative `amount_cents`) and confirm the outbox INSERT
  never even runs - the transaction never reaches its second statement.
- Add a third statement to `performTransactionalOrderCreation` (for example,
  a second outbox event for a different, hypothetical downstream concern)
  and inject a failure between the second and third INSERT - confirm
  `ROLLBACK` undoes all three.
- Change `src/scripts/drain-outbox.ts`'s injected failure test in
  `playground/notes.md` to leave an event genuinely stuck, then try running
  two `pnpm outbox:drain` invocations at the same instant against several
  pending events - watch (via the injectable `publish` callback) whether the
  same event is ever published by both processes, since this drain script
  does not use `FOR UPDATE SKIP LOCKED`.
- Increase the seed's `--size` and watch how many baseline orders/outbox
  events PGweb shows, all pre-published - contrast with the always-unpublished
  rows the transactional-outbox scenario and tests create.
- Read `src/scenarios/transactional-outbox.ts` and confirm for yourself
  (`grep -n publishToBroker`) that the write path never imports or calls the
  broker at all - the structural test in
  `tests/integration/transactional-outbox.test.ts` checks this the same way.
