# Lab 20 - Sagas and Distributed Workflows

## Why this exists

Every prior lab in Phase 4 solved one piece of "how do I keep something
correct when a single ACID transaction can't cover it": Lab 16 taught the
transactional outbox (write business state and an event atomically), Lab 18
taught idempotent consumers (make redelivery safe). This lab is the
synthesis: a real four-step order workflow - `CreateOrder -> ReserveInventory
-> CapturePayment -> CreateShipment` - where each step is modeled as its own
bounded context with its own table, and NO single database transaction can
span all four (in a real system they would be four different services with
four different databases; even here, wrapping them in one transaction would
defeat the entire point of a saga - see "Architecture"). When the last step
fails, there is no `ROLLBACK` that undoes the first three - something has to
explicitly notice the failure and run compensating actions to undo the
already-committed work. That "something" can be organized two ways -
**orchestration** (one coordinator that knows the whole workflow) or
**choreography** (each step reacts only to the event immediately before it,
with no coordinator at all) - and this lab builds both, against the
identical business logic, so their complexity and observability tradeoffs
are measured, not asserted.

## Learning objectives

After this lab you should be able to:

- explain why a saga is a sequence of independent, separately-committed
  local transactions, not one distributed transaction - and why "just wrap
  it all in `BEGIN`/`COMMIT`" is not an option once a failure can only be
  discovered after earlier steps have already committed;
- implement compensating actions for a multi-step workflow and show they run
  in the *reverse* order of whichever forward steps actually succeeded, not
  a fixed order;
- distinguish orchestration (one coordinator explicitly calling every step
  and every compensation) from choreography (steps reacting to events, no
  coordinator) using the same underlying business operations for both;
- point to a real, measured `saga_log` entry-count and actor-count
  difference between the two mechanisms for the identical business outcome,
  and explain concretely why choreography is harder to trace;
- explain why a saga only provides *eventual, compensated* consistency, not
  atomicity - and what a caller could observe (e.g. "payment captured")
  during the window before a compensation finishes.

## Architecture

```text
orders                    inventory_items         payments        shipments
  id, public_id             id, sku                  id              id
  customer_name             name                     order_id        order_id
  amount_cents               available_quantity       amount_cents    status ('created')
  status                                              status
  ('pending'/'completed'/                            ('captured'/
   'cancelled')                                        'refunded')
       ▲                         ▲
       │ order_id                │ item_id
       └──── inventory_reservations ────┘
              id, quantity, status ('reserved'/'released')

saga_log   <- the primary observability artifact (see "Observe")
  id, order_id, mechanism ('orchestration'/'choreography'),
  step_name, direction ('forward'/'compensate'),
  outcome ('success'/'failure'/'published'/'consumed'), occurred_at, detail (jsonb)
```

Domain: a fresh, minimal order-lifecycle schema, new in this lab (no import
from Lab 16's `orders`/`outbox_events` or any other lab's schema, per
CLAUDE.md's independent-labs principle). Each business table stands in for
what would be a separate service's database in a real distributed system -
this lab models that with plain tables in one Postgres instance, per
CLAUDE.md's infrastructure-minimalism guidance ("this is a
single-Postgres-database lab, not a real multi-service distributed
system" - no message broker, no separate processes).

**Why each step is its own transaction, not one big one.** `src/domain/run-
step.ts`'s `runStep` helper wraps exactly one step's business write (plus
its own `saga_log` row) in one `BEGIN`/`COMMIT`. `runOrderSaga` in
`src/orchestration/orchestrator.ts` calls four of these, one after another -
never inside a shared transaction. This is deliberate: a saga exists
*because* a single transaction can't span multiple services. Simulating it
with one giant local transaction would hide the exact problem this lab
teaches - that a failure discovered at step 4 cannot simply `ROLLBACK` steps
1-3, because they already committed and (in a real system) other
transactions may have already observed their effects.

**Why failures are injected *before* a step's own write, not mid-write.**
`opts.failAtStep` (see `src/domain/run-step.ts` and `createOrderStep`)
throws before the step's `work()` runs any business write, modeling "this
step's own attempt was rejected" (e.g. the carrier API declined the
shipment) rather than a mid-statement crash (Lab 05 already covers that
failure shape for a single transaction). This keeps the compensation story
clean: a failed step never partially wrote anything of its own to begin
with - only *earlier, already-succeeded* steps need undoing.

**`orders.status` has no separate `failed` state.** Once compensation
finishes, the order's business meaning is "this order was cancelled," not
"this order is broken" - so a saga that fails ends at `status = 'cancelled'`
(via the `cancelOrder` compensation), the same terminal state a customer-
initiated cancellation would produce. `saga_log` still records exactly which
step failed and why (see `detail.reason`), so nothing about *why* it was
cancelled is lost.

**`saga_log.mechanism` is a deliberate addition beyond the brief's literal
column list** (`id, order_id, step_name, direction, outcome, occurred_at,
detail`). Without it, telling an orchestration row from a choreography row
would require inferring it from `step_name` shape - `mechanism` makes the
whole "Observe" comparison a single `WHERE mechanism = ...`, which is the
entire reason this table exists.

Two implementations of the identical business steps:

```text
src/domain/steps.ts               <- forward steps (createOrder, reserveInventory,
                                      capturePayment, createShipment, completeOrder),
                                      mechanism-agnostic
src/domain/compensating-steps.ts  <- compensations (refundPayment, releaseInventory,
                                      cancelOrder), mechanism-agnostic
src/domain/run-step.ts            <- shared one-transaction-per-step + saga_log plumbing
src/domain/saga-log.ts            <- the saga_log INSERT helper

src/orchestration/orchestrator.ts <- runOrderSaga(): one coordinator function,
                                      calls every step directly, compensates
                                      in reverse order on failure
src/orchestration/compensation.ts <- orchestration's narrow bindings over the
                                      shared compensating steps

src/choreography/event-bus.ts     <- a minimal in-process pub/sub dispatcher
                                      (NOT a real broker - see below)
src/choreography/handlers.ts      <- one handler per (event, service) pair;
                                      no handler calls any other directly
src/choreography/run.ts           <- runChoreographedOrderSaga(): creates the
                                      order, publishes OrderCreated, and
                                      awaits the entire resulting cascade
```

Both mechanisms call the *same* `src/domain/steps.ts` /
`compensating-steps.ts` functions with a different `mechanism` tag - the
business operations never change; only who decides when to call them does.

Choreography's event bus is a plain in-process dispatcher over an
`EventEmitter`-shaped `Map`, not a real message queue/broker (per the
brief's explicit scope and CLAUDE.md's infrastructure-minimalism
guidance). `EventBus.publish` logs the publish, then awaits each
subscriber's handler in turn; each handler awaits its own downstream
`publish` calls before returning, so the *entire* cascade for one order
resolves before the top-level `await bus.publish(...)` in
`runChoreographedOrderSaga` returns - there is no background queue or poll
loop to reason about.

The choreography compensation chain reacts hop-by-hop, exactly like the
forward chain, with no shared "the saga failed" broadcast:

```text
forward:     OrderCreated -> InventoryReserved -> PaymentCaptured -> ShipmentCreated
compensate:  ShipmentFailed -> (payment-service refunds) -> PaymentRefunded
             -> (inventory-service releases) -> InventoryReleased
             -> (order-service cancels) -> OrderCancelled

             PaymentFailed -> (inventory-service releases) -> InventoryReleased -> ...
             InventoryReservationFailed -> (order-service cancels) -> OrderCancelled
```

## Setup

```bash
pnpm install
cp labs/20-sagas-and-distributed-workflows/.env.example labs/20-sagas-and-distributed-workflows/.env
cd labs/20-sagas-and-distributed-workflows
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate
pnpm seed --seed=42 --size=small   # fixed 5-SKU catalog, quantities scaled by --size
```

Open PGweb at http://localhost:8420 (auto-connects via
`PGWEB_DATABASE_URL`). You should see 5 rows in `inventory_items` and every
other table empty until you run one of the scenario scripts below.

## Scenario

A small store sells five products. A customer order runs through four
steps - reserve stock, take payment, create a shipment - and each step
belongs to a different bounded context (inventory, payments, shipping) that,
in a real system, cannot commit atomically with any of the others. This lab
introduces a failure *after payment has already been captured*: the carrier
API rejects shipment creation. By that point, inventory has been reserved
and money has been taken - both are real, committed side effects that must
be explicitly undone, in the right order, or the store leaks stock and holds
a customer's money for an order that will never ship.

## Prediction

Before running anything, predict:

1. If `createShipment` fails after `createOrder`, `reserveInventory`, and
   `capturePayment` have all already committed, what does Postgres do about
   the earlier three steps on its own? (Hint: they are three separate,
   already-committed transactions by the time step four fails - is there
   anything left for a database-level `ROLLBACK` to undo?)
2. In what order should the compensations run - the same order as the
   forward steps, or reversed? Why?
3. If only `reserveInventory` succeeds and `capturePayment` is the one that
   fails, should `refundPayment` be called at all?
4. Which implementation - orchestration or choreography - do you expect to
   produce more `saga_log` rows for the identical outcome, and why?

## Exercise

1. Run the setup commands above.
2. Run the happy-path orchestrated saga - all four steps succeed:
   ```bash
   pnpm scenario:happy-path
   ```
3. Run the failure-and-compensation orchestrated saga - `createShipment` is
   forced to fail, and the three prior successes are compensated:
   ```bash
   pnpm scenario:failure-and-compensation
   ```
4. Run the choreography comparison - the same two scenarios run through the
   choreographed implementation, plus a `saga_log` count/actor comparison
   against the orchestrated runs:
   ```bash
   pnpm scenario:choreography-comparison
   ```
5. Run `pnpm test` and read `tests/integration/orchestration.test.ts`,
   `tests/integration/choreography-equivalence.test.ts`, and
   `tests/integration/saga-log-observability.test.ts` - these assert the
   exact invariants below as real, automated checks.

## Observe

- **PGweb** (http://localhost:8420): after running all three scenario
  scripts, open `saga_log` and filter by `order_id` for one orchestrated
  order and one choreographed order. Read both top to bottom in
  `occurred_at` order.
- **The orchestrated order's `saga_log`** is a short, linear sequence you
  can narrate directly: `createOrder` succeeded, `reserveInventory`
  succeeded, `capturePayment` succeeded, `createShipment` failed,
  `refundPayment` succeeded, `releaseInventory` succeeded, `cancelOrder`
  succeeded. Every row's `detail` has no `publishedBy`/`consumedBy` field -
  there is only one actor, the orchestrator itself.
- **The choreographed order's `saga_log`** for the identical business
  outcome has real, captured counts from this lab's own validation run
  (seed 42, `--size=small`):

  | scenario | mechanism | `saga_log` rows | distinct actors |
  |---|---|---|---|
  | happy path | orchestration | **5** | 0 (single coordinator) |
  | happy path | choreography | **13** | 4 (`order-service`, `inventory-service`, `payment-service`, `shipment-service`) |
  | failure + compensation | orchestration | **7** | 0 |
  | failure + compensation | choreography | **20** | 4 |

  Reconstructing the choreographed failure trace requires following the
  chain `shipment-service -(ShipmentFailed)-> payment-service
  -(PaymentRefunded)-> inventory-service -(InventoryReleased)->
  order-service` - four services, three event hops, each one only a
  `WHERE consumedBy = ...` away from the next. The orchestrated trace never
  requires leaving the single `orchestrator.ts` file's log lines.
- **Structured logs**: every step's log line (`@labs/logging`/Pino) includes
  `orderId` and `step`, so a single order's execution is traceable from
  process logs alone - `docker compose logs` is not needed for this lab
  since there is only one process, but grepping stdout for
  `"orderId":"<id>"` reconstructs the same story `saga_log` does.
- **`SELECT * FROM saga_log WHERE outcome = 'failure';`**: in production,
  this is the query an on-call engineer runs first when a saga alert fires -
  it points directly at which step and which order, with `detail.reason`
  carrying the underlying error.

## Break it

Imagine (or actually try, per "Further experiments") commenting out the
three compensation calls in `runOrderSaga`'s `createShipment`-failure
branch. Real captured state right after `createShipment` fails, from this
lab's own validation run, BEFORE compensation runs (order 2, SKU
`SKU-MONITOR-004`, quantity 1):

```text
orders:                  id=2  status='pending'      (never advanced past pending)
inventory_reservations:  order_id=2  status='reserved'  quantity=1
payments:                order_id=2  status='captured'  amount_cents=34999
shipments:                (no row - createShipment never committed)
inventory_items:         SKU-MONITOR-004  available_quantity=89  (90 - 1, still reserved)
```

Without compensation, this is a real resource leak: the customer's card was
charged $349.99 for an order that will never ship, and one unit of stock
that could have been sold to someone else is permanently locked in a
`reserved` state that nothing will ever release. `orders.status` is stuck at
`pending` forever - the same "orphaned row" symptom Lab 05's naive transfer
leaves behind, just one workflow step later and across four tables instead
of two.

## Fix it

Run:

```bash
pnpm scenario:failure-and-compensation
```

Real captured output from this lab's own validation run:

```text
step failed - compensating already-succeeded steps, in reverse order
  orderId: "2"   step: "createShipment"
  reason: "simulated failure: carrier API rejected shipment creation for order c052a011-..."
compensation succeeded   orderId: "2"   step: "refundPayment"
compensation succeeded   orderId: "2"   step: "releaseInventory"
compensation succeeded   orderId: "2"   step: "cancelOrder"

COMPENSATION CONFIRMED: payment refunded, inventory released back to its
exact pre-reservation count, order cancelled, no shipment exists
  orderId: 2            orderStatus: "cancelled"
  itemSku: "SKU-MONITOR-004"
  quantityBefore: 90    quantityAfter: 90    inventoryRestored: true
  reservationStatus: "released"
  paymentStatus: "refunded"
  shipmentCount: 0
```

The key invariant: `quantityAfter` (90) equals `quantityBefore` (90) - not
"close to," not "a status flag says released," the actual integer count of
units available for sale is back to what it was before this order ever
touched it. `pnpm test` captures this as a real assertion
(`tests/integration/orchestration.test.ts`, "refunds payment, releases
inventory back to its exact pre-reservation count"), plus an equivalence
test proving the choreographed implementation reaches the identical
restored count independently.

```text
✓ tests/integration/orchestration.test.ts (3 tests) 67ms
✓ tests/integration/choreography-equivalence.test.ts (2 tests)
✓ tests/integration/saga-log-observability.test.ts (2 tests) 79ms

Test Files  3 passed (3)
     Tests  7 passed (7)
```

## Why the fix works

Compensation works by running the exact inverse of each already-succeeded
step, in the exact reverse order those steps ran in - `refundPayment`
(undoes `capturePayment`), then `releaseInventory` (undoes
`reserveInventory`), then `cancelOrder` (undoes `createOrder`, in the sense
that the order will never reach `completed`). Reverse order matters because
later steps can depend on earlier ones being in place - e.g. a real
`refundPayment` might legitimately require reading the reservation the
payment was authorized against before that reservation is released.
`createShipment` itself is never compensated because nothing durable was
ever written by the failed attempt: `src/domain/run-step.ts`'s
`simulateFailure` check happens *before* any business write in a step's
`work()` function runs, so the failing step's own transaction has nothing to
roll back beyond its own no-op.

Each compensation is, itself, an ordinary local transaction (via the same
`runStep` helper the forward steps use) - it succeeds or fails as a unit,
the same atomicity guarantee Lab 05 covers, just applied to an "undo"
operation instead of a "do" operation. The saga's overall correctness comes
from an invariant this lab enforces in application code, not from any single
database transaction: *every forward step that commits gets a matching
compensation if the saga does not reach `completed`.* Postgres has no way to
know that four separate transactions "belong to" one saga - `runOrderSaga`'s
control flow (which steps succeeded, tracked implicitly by which `if
(...failed)` branch was and wasn't taken) is what carries that
knowledge, and `saga_log` is what makes it durable and inspectable
afterward.

## Tradeoffs

- **A saga trades atomicity for availability across independent local
  transactions.** There is a real window, between `capturePayment`
  committing and `refundPayment` committing, during which the system's true
  state is "payment captured, shipment failed, compensation in progress." A
  read during that window (e.g. a support agent looking up the order) would
  see a captured payment with no shipment - technically correct at that
  instant, but not the *final* state. A single ACID transaction would never
  expose that intermediate state to anyone; a saga inherently can.
- **Orchestration concentrates complexity into one place, which is both its
  strength and its cost.** `runOrderSaga` is one function you can read
  top-to-bottom to know the entire workflow and every failure path - but it
  is also a single component that must know about every step and every
  compensation. Adding a fifth step means editing the orchestrator.
- **Choreography distributes complexity, trading a single hotspot for
  cross-cutting indirection.** No single file in `src/choreography/`
  describes the whole workflow - `handlers.ts` is seven independent
  functions, and understanding "what happens when `createShipment` fails"
  requires following `ShipmentFailed -> PaymentRefunded ->
  InventoryReleased -> OrderCancelled` across four handler registrations.
  Adding a fifth step means adding a new handler and updating exactly the
  handlers immediately before and after it in the chain - smaller
  individual changes, but the full picture is nowhere in one place. This
  lab's own measured numbers make that concrete: for the identical
  business outcome, choreography needed **13 vs. 5** `saga_log` rows on the
  happy path and **20 vs. 7** on the failure path, and required tracing
  across **4 vs. 0** named actors.
- **Compensations here cannot themselves fail.** This lab's `refundPayment`
  / `releaseInventory` / `cancelOrder` are simple, always-succeed UPDATEs -
  real systems must handle a compensation that itself fails (e.g. the
  refund API is down), which needs its own retry/backoff and possibly a
  human-in-the-loop escalation path this lab does not build (see "Further
  experiments").
- **Choreography's event bus here is in-process and synchronous-by-await,
  not a real broker.** A real choreographed saga across real services needs
  at-least-once delivery, ordering guarantees (or the lack thereof), and
  idempotent consumers (Lab 18) at every hop - none of which this
  single-process simulation has to contend with, because there is no
  network between "services" here.

## Production notes

1. **What guarantee does this mechanism give?** Eventual, *compensated*
   consistency: if every forward step and every required compensation
   eventually runs to completion, the system ends up in a valid terminal
   state (`completed` or `cancelled`, with every business table
   consistent with that outcome) - just not instantaneously, and not
   atomically from an outside observer's point of view.
2. **What does it not guarantee?** Isolation. Nothing in this lab prevents
   another process from reading `payments.status = 'captured'` in the
   window before `refundPayment` runs - a real customer-facing UI could
   briefly show "payment successful" for an order that is about to be
   cancelled. It also does not guarantee compensations succeed - see
   "Tradeoffs."
3. **What breaks under process crash?** If the orchestrator process crashes
   mid-saga (after `capturePayment` commits, before `createShipment` even
   starts), `saga_log` and the business tables show exactly the same
   "captured, no shipment" state as a real `createShipment` failure - but
   nothing will ever call the compensations, because the in-memory
   `runOrderSaga` call stack that was going to call them is gone. A
   production orchestrator needs a durable saga-state table (not just a log)
   that a recovery process can scan for orders stuck mid-flight and resume
   or compensate. This lab's `saga_log` is an audit trail, not (by itself) a
   resumable state machine - that distinction matters.
4. **How does contention affect it?** Each step's own transaction is short
   (a handful of statements), so lock contention within one step behaves
   like any of Labs 05/10's short transactions. The saga-level "duration" -
   from `createOrder` to the terminal state - is unbounded by Postgres
   locking, since no lock is held across steps; contention across many
   *different* orders competing for the same low-stock SKU is a
   `reserveInventory`-level concern (`SELECT ... FOR UPDATE` inside that
   step, same as Lab 10).
5. **What changes at larger scale?** A real system runs `createOrder`,
   `reserveInventory`, `capturePayment`, and `createShipment` as four
   separate services, each an independent point of failure and each
   requiring its own retry/timeout policy (Lab 37). Choreography's
   observability cost grows with the number of steps and services -
   this lab's 4-step chain already needs a full trace across 4 actors;
   a 10-step real-world saga choreographed the same way needs a trace
   across 10, while an orchestrator's trace stays a flat list regardless of
   step count.
6. **What metrics would be monitored?** Count and age of orders stuck in a
   non-terminal state past an expected duration (the saga equivalent of Lab
   05's "`transfers` stuck at `pending`"); `saga_log` failure rate by step
   (which step fails most often - that's where compensation logic gets
   exercised most); for choreography specifically, per-event consumer lag
   or drop rate, since there is no single place that would otherwise notice
   a handler silently failing to fire.
7. **When should this approach be avoided?** When all the steps genuinely
   live in the same database and can be one ACID transaction - a saga is
   strictly more complex and should not be reached for out of habit. Prefer
   orchestration when the workflow is owned by one team/service and
   changes together; prefer choreography only when the steps are already
   independently-owned services that must not know about each other, and
   only if the observability cost (durable event log, distributed tracing)
   is budgeted for up front - this lab's own numbers show that cost is not
   small even at four steps.

## Interview questions

1. Why can't the four steps in this lab's saga be wrapped in one Postgres
   transaction? What would that even mean if `reserveInventory` and
   `capturePayment` were genuinely different services with different
   databases?
2. Walk through exactly why compensations run in reverse order. Construct a
   (contrived) example where running them in forward order instead would be
   wrong.
3. This lab's `createShipment` step has no compensation function. Why not,
   and what would have to change about the domain for it to need one (hint:
   what if `createShipment` could partially succeed - e.g. the carrier
   accepts the shipment but the label print fails)?
4. What does `saga_log`'s `mechanism` column let you do that you couldn't
   do with `step_name` and `direction` alone? Was adding it worth
   deviating from the brief's literal column list?
5. If the orchestrator process crashes between `capturePayment` committing
   and `createShipment` starting, what state is the system left in, and
   what would a recovery process need to know that isn't captured anywhere
   in this lab's schema?
6. Why does choreography need roughly 2.5-3x as many `saga_log` rows as
   orchestration for the identical outcome in this lab's measurements?
   Which of those extra rows are "real work" versus "bookkeeping about who
   talked to whom"?
7. A teammate proposes choreography for a new 8-step workflow "because it's
   more decoupled." What follow-up questions would you ask before agreeing?

## Further experiments

- Implement a `failAtStep: "reserveInventory"` and `failAtStep:
  "capturePayment"` run through `pnpm scenario:choreography-comparison`
  (or add a new scenario script) and confirm the compensation chain
  correctly shortens (e.g. no `refundPayment` at all if payment was never
  captured) in both mechanisms.
- Make `refundPaymentStep` fail some percentage of the time (a random
  throw before its `UPDATE`) and think through what the orchestrator and
  the choreography handlers would each need to do differently to recover -
  retry with backoff? Dead-letter the saga for a human? Notice neither
  implementation currently has anywhere to put that logic.
- Add a fifth forward step (e.g. `sendConfirmationEmail`, no compensation
  needed) to both `src/orchestration/orchestrator.ts` and
  `src/choreography/handlers.ts`, and measure how much `saga_log` traffic
  the new step adds to each - confirm the orchestrator's addition is one
  more explicit call in one function, while choreography's is a new handler
  plus rewiring the handler immediately before it.
- Replace the in-process `EventBus` with something that genuinely queues
  events (e.g. writes them to a table other than `saga_log` and a separate
  poller drains them with `SKIP LOCKED`, à la Lab 14) and observe what new
  failure modes appear (duplicate delivery, out-of-order handling) that the
  synchronous in-process bus in this lab cannot exhibit.
- Run `pnpm scenario:choreography-comparison` several times back-to-back
  and use PGweb to look at how quickly `saga_log` grows compared to
  `orders` - project what a production system doing thousands of sagas a
  day would need for log retention/partitioning.

