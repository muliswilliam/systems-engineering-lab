# Lab 12 - Ticket Reservation System

## Why this exists

Labs 05 (transactions), 07 (isolation), and the row-lock/conditional-write
concepts from Phase 3 all point at the same real-world problem: two buyers
click "Reserve" on the same seat at (almost) the same instant, and only one
of them should get it. A naive implementation - read the seat's status in
application code, decide it's available, then issue a separate `UPDATE` -
looks correct in a single-user test and is completely broken under
concurrency: nothing stops two, ten, or a hundred concurrent readers from all
seeing `AVAILABLE` before any of them writes. This lab builds that race for
real, on a real Postgres instance, with a real measured "how many buyers
believed they got the seat" number - and then fixes it two different ways
(a conditional `UPDATE`, and `SELECT ... FOR UPDATE`), both of which reduce
the same 100-concurrent-attempt experiment to exactly one winner.

## Learning objectives

After this lab you should be able to:

- explain precisely why "read status, check it in code, then write" is
  unsafe under concurrency even though each individual statement is
  internally correct;
- implement the fix as a single conditional `UPDATE ... WHERE status =
  'AVAILABLE'` and explain why `rowCount` (not the read you did a moment ago)
  is the only trustworthy signal of success;
- implement the alternative fix with `SELECT ... FOR UPDATE` inside a
  transaction, and explain what it costs (an open transaction/connection for
  the hold's duration, other writers queuing behind the lock) that the
  conditional write does not;
- extend a state machine (`AVAILABLE -> RESERVED -> SOLD`, `RESERVED ->
  AVAILABLE`) with a time-based edge (expiration) implemented as one more
  conditional `UPDATE`, safe to run concurrently with itself and with a
  payment completing at the same instant;
- point to a real captured number - not a theoretical description - showing
  how many of 100 concurrent attempts against the same seat "succeeded" under
  each of the three mechanisms.

## Architecture

```text
events (id, public_id, name, venue_name, event_at)
   ▲
   │ event_id
   └── seats (id, public_id, section, row, seat_number,
              status, reservation_token, reserved_by, reserved_until)
```

Domain: **ticketing** (SPEC.md 8.2), new in this lab. SPEC.md's aspirational
entity list for the whole curriculum's ticketing domain is much larger
(venues, sections, seats, ticket inventory, reservations, orders, payments) -
that is a target for the *entire curriculum*, not a requirement for any one
lab. This lab deliberately keeps the schema flat:

- **No separate `venues`/`sections` tables.** `seats.section`/`row` are plain
  `text` columns and `seat_number` is a plain `integer`, not foreign keys
  into a normalized venue model. A `UNIQUE (event_id, section, row,
  seat_number)` constraint still guarantees no two seat rows collide for the
  same event.
- **No separate `reservations` table.** A reservation *is* a seat's own
  state - `status = 'RESERVED'` plus `reservation_token`/`reserved_by`/
  `reserved_until` on the same row - rather than a joined row in another
  table. Every scenario in this lab reads and writes exactly one row per
  attempt, which is the point: the race, the fix, and the invariant are all
  about a single row's state transitions, and a second table would add
  relational noise without teaching anything extra here.
- **No `orders`/`payments` tables.** `complete-payment.ts` models "payment
  succeeded" as the seat's own `RESERVED -> SOLD` transition; a real system
  would also write an `orders`/`payments` row in the same statement/
  transaction, which is exactly the transactional-outbox territory of
  Lab 16+, not this lab's concept.

`status` is a plain `text` column with a `CHECK (status IN ('AVAILABLE',
'RESERVED', 'SOLD'))` rather than a Postgres `ENUM` type, matching this
repo's general preference for metadata-only evolution over `ALTER TYPE`.

Five scenario scripts, all operating on the same `seats` table:

```text
src/scenarios/naive-reservation.ts       <- SELECT, check in app code, separate UPDATE (BROKEN)
src/scenarios/conditional-reservation.ts <- single UPDATE ... WHERE status = 'AVAILABLE' (FIX, primary)
src/scenarios/row-lock-reservation.ts    <- BEGIN; SELECT ... FOR UPDATE; UPDATE; COMMIT (FIX, alternative)
src/scenarios/expire-reservations.ts     <- conditional UPDATE reverting lapsed holds to AVAILABLE
src/scenarios/complete-payment.ts        <- conditional UPDATE transitioning RESERVED -> SOLD
```

All five use the raw `pg` `Pool`/`Client` directly, not Drizzle's query
builder, for the same reason Labs 05/07 do: per CLAUDE.md's "ORM plus SQL"
principle, a conditional `WHERE` clause and an explicit `FOR UPDATE` lock are
exactly the kind of thing that should be visible as real SQL. Schema
definition and migrations still use Drizzle.

The naive and row-lock scenarios each open **one real Postgres connection
per concurrent attempt** (`pool.connect()`, not a shared pool awaited
sequentially) - see "Break it" for why that matters and what happens if you
don't.

## Setup

```bash
pnpm install
cp labs/12-ticket-reservation-system/.env.example labs/12-ticket-reservation-system/.env
cd labs/12-ticket-reservation-system
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate
pnpm seed --seed=42 --size=small   # 3 events, 30 seats each
```

Open PGweb at http://localhost:8412 (auto-connects via
`PGWEB_DATABASE_URL`). You should see 3 rows in `events` and 90 rows in
`seats`, all `status = 'AVAILABLE'`.

## Scenario

A small venue is selling seats for a handful of events. Many buyers can be
looking at the same seat map at once, and more than one of them can click
"Reserve" on the exact same seat within milliseconds of each other. The
invariant this whole lab is about:

> At most one buyer may ever hold an active `RESERVED` or `SOLD` state for a
> given seat at a time - no matter how many buyers attempt to reserve it
> concurrently.

A reservation is a temporary hold (it has a `reserved_until` expiration and a
`reservation_token` the buyer needs to complete payment); a sale is
permanent. Both transitions must obey the same single-winner invariant.

## Prediction

Before running anything, predict:

1. If a reservation is implemented as `SELECT status` (check `AVAILABLE` in
   application code) followed by a separate `UPDATE`, and 100 buyers attempt
   the same seat at once, how many of them do you expect to believe they got
   the seat? Exactly 1? More than 1? All 100?
2. If the `UPDATE` in the naive version has no `WHERE status = 'AVAILABLE'`
   clause, does `rowCount` from that `UPDATE` tell you anything about whether
   the reservation was actually safe?
3. A single `UPDATE ... WHERE id = $1 AND status = 'AVAILABLE'` needs no
   `BEGIN`/`COMMIT` around it to be safe under concurrency. Why not - what is
   providing the atomicity here?
4. `SELECT ... FOR UPDATE` inside a transaction also fixes the race. What
   does it cost that the conditional `UPDATE` does not?
5. A payment completion check requires `reserved_until > now()`. If the
   expiration worker (`expire-reservations.ts`) has not run yet for a seat
   whose hold already lapsed, does a payment attempt against that seat still
   correctly fail?

## Exercise

1. Run the setup commands above.
2. Run the naive scenario and read the real captured numbers below in
   "Break it" - then run it yourself and compare:
   ```bash
   pnpm scenario:naive
   ```
3. Run both fixes and compare against "Fix it" below:
   ```bash
   pnpm scenario:conditional
   pnpm scenario:row-lock
   ```
4. Run the expiration worker and the payment scenario:
   ```bash
   pnpm scenario:expire
   pnpm scenario:payment
   ```
5. Run `pnpm test` and read through `tests/integration/naive-reservation.test.ts`
   (asserts the race is real - NOT exactly one success) alongside
   `conditional-reservation.test.ts` and `row-lock-reservation.test.ts`
   (both assert exactly one success out of 100 concurrent attempts).

## Observe

- **PGweb** (http://localhost:8412): after `pnpm scenario:naive`, look at the
  one seat row that was raced - its `status` will be `RESERVED` with exactly
  one `reserved_by` value (whichever `UPDATE` physically executed last), even
  though the logs show many buyers believed they won it.
- **`docker compose logs postgres`**: `log_statement=all` makes every
  literal `SELECT`, `UPDATE`, `BEGIN`, and `COMMIT` visible - compare the
  naive scenario (two independent statements per attempt, no `BEGIN`) against
  the row-lock scenario (`BEGIN` ... `SELECT ... FOR UPDATE` ... `COMMIT` per
  attempt).
- **`SELECT * FROM pg_locks WHERE relation = 'seats'::regclass;`** while
  `pnpm scenario:row-lock` is running (best observed by adding a short sleep
  inside the transaction in a scratch copy) - other attempts' `FOR UPDATE`
  requests queue up behind whichever transaction currently holds the lock.
- **Structured logs**: every scenario logs through `@labs/logging` (Pino)
  with `attempts`/`reserved`/`rejected`/`believedReserved` fields, so the
  invariant (or its violation) is a field in the log line.

## Break it

Run:

```bash
pnpm scenario:naive
```

Real captured output from this lab's own validation run (seed 42,
`--size=small`, 100 concurrent attempts, one seat):

```text
starting naive reservation race
  seatId: 91   attempts: 100   artificialDelayMs: 50
RACE CONFIRMED: more than one concurrent attempt believed it reserved the same seat
  seatId: 91   attempts: 100
  believedReserved: 73   rejected: 27
  finalStatus: "RESERVED"   finalReservedBy: "buyer-14@example.com"
```

Rerunning it three more times back to back produced `believedReserved: 100`
every time (all 100 concurrent attempts read `AVAILABLE` and wrote
`RESERVED`, and only the very last physical `UPDATE` to execute is what
survives in the row) - the exact count is a race, but "more than one" is
reliable across every run.

**What it took to make this reliably reproduce.** An early version of this
scenario shared a single small connection pool across all 100 attempts and
had no delay between the read and the write - on a fast local Postgres, the
100 attempts sometimes serialized enough (connection acquisition latency,
Node's own scheduling) that the race under-reproduced. Two changes fixed
that, matching CLAUDE.md's "delays only when needed to make the race
observable":

1. **One real connection per attempt.** `naive-reservation.ts` calls
   `pool.connect()` per attempt and creates the pool with
   `max: ATTEMPTS + 10`, so all 100 attempts are genuinely concurrent
   physical connections, not queued behind a handful of pooled ones.
2. **A 50ms artificial delay between the read and the write.** This widens
   the window during which every concurrent reader still sees the
   pre-reservation `AVAILABLE` value, which is exactly the failure mode a
   slower production system (a network hop to a payment-risk check between
   "read seat" and "write reservation," for example) would experience
   naturally, without needing an artificial delay at all.

Why the naive `UPDATE`'s `rowCount` is useless here: it always affects
exactly one row, because its `WHERE` clause only ever matches on `id`
(`WHERE id = $1`), which always exists. There is no signal in the write
itself that anything went wrong - the corruption is entirely in the gap
between the read and the write.

## Fix it

**Primary fix - conditional write:**

```bash
pnpm scenario:conditional
```

Real captured output, same setup:

```text
starting conditional-write reservation attempts
  seatId: 91   attempts: 100
INVARIANT HELD: exactly one of the concurrent attempts reserved the seat
  seatId: 91   attempts: 100
  reserved: 1   rejected: 99
  finalStatus: "RESERVED"   finalReservedBy: "buyer-0@example.com"
```

**Alternative fix - row lock:**

```bash
pnpm scenario:row-lock
```

Real captured output, same setup:

```text
starting row-lock reservation attempts
  seatId: 91   attempts: 100
INVARIANT HELD: exactly one of the concurrent attempts reserved the seat
  seatId: 91   attempts: 100
  reserved: 1   rejected: 99
  finalStatus: "RESERVED"   finalReservedBy: "buyer-0@example.com"
```

Both mechanisms reduce the identical 100-concurrent-attempt experiment from
"73-100 believe they won" (naive) to exactly 1. `pnpm test` captures all
three as real assertions:

```text
✓ tests/integration/complete-payment.test.ts (4 tests)
✓ tests/integration/expire-reservations.test.ts (3 tests)
✓ tests/integration/naive-reservation.test.ts (1 test)
✓ tests/integration/conditional-reservation.test.ts (2 tests)
✓ tests/integration/row-lock-reservation.test.ts (2 tests)

Test Files  5 passed (5)
     Tests  12 passed (12)
```

The expiration worker and payment scenarios are the other two edges of the
state machine:

```bash
pnpm scenario:expire
```
```text
before running the expiration worker
  expiredButNotYetReverted: 1
expiration worker reverted expired reservations back to AVAILABLE
  expiredCount: 1   expiredSeatIds: [91]
```

```bash
pnpm scenario:payment
```
```text
happy path: valid, unexpired token -> outcome: "sold"
failure path: wrong/stale reservation token -> outcome: "failed"
failure path: reservation expired (reserved_until in the past) -> outcome: "failed"
```

## Why the fix works

**Conditional write.** `UPDATE seats SET status = 'RESERVED', ... WHERE id =
$1 AND status = 'AVAILABLE'` puts the read and the write in the *same*
atomic statement. Postgres does not let two concurrent `UPDATE`s targeting
the same row interleave their WHERE-clause evaluation and their write: the
second `UPDATE` to actually execute against this row's current version must
re-evaluate `status = 'AVAILABLE'` against whatever the first `UPDATE` just
committed (or, if concurrent, blocks briefly until the first one resolves,
then re-evaluates). Exactly one `UPDATE` can ever see `status = 'AVAILABLE'`
still true at the moment it writes; every other one gets `rowCount = 0`, a
completely unambiguous "you lost" signal that requires no separate read to
interpret.

**Row lock.** `BEGIN; SELECT status FROM seats WHERE id = $1 FOR UPDATE`
acquires an exclusive row lock and holds it until `COMMIT`/`ROLLBACK`. Any
other transaction's `SELECT ... FOR UPDATE` (or plain `UPDATE`) against the
same row blocks until the lock is released - so by the time a second
attempt's locking `SELECT` actually returns, it is guaranteed to see
whatever the first attempt just committed. The application-level `if (status
!== 'AVAILABLE')` check, which was unsafe in the naive version, becomes safe
here specifically because the lock closes the exact window the naive version
left open.

**Expiration and payment.** Both are the same conditional-write pattern
applied to time: `WHERE status = 'RESERVED' AND reserved_until < now()`
(expire) and `WHERE status = 'RESERVED' AND reservation_token = $2 AND
reserved_until > now()` (pay) are each a single atomic statement, so running
the expiration worker and a payment attempt against the same seat at the
same instant cannot corrupt anything - whichever one Postgres executes
second simply finds its own WHERE clause no longer matches and affects zero
rows.

## Tradeoffs

- **Conditional write vs row lock.** The conditional write never blocks
  anyone - every concurrent attempt gets an instant win/lose answer with no
  open transaction and no held connection beyond the single statement's
  duration, which scales better under contention (this lab's 100-attempt
  benchmark: both fixes hit exactly 1 success, but the conditional write's
  99 "losers" each did one round-trip while the row lock's 99 losers each
  opened a transaction, waited on a lock, and rolled back). The row lock's
  advantage shows up once a reservation needs to touch *multiple* rows/
  tables consistently - e.g. also decrementing a per-section inventory
  counter, or writing an audit row - inside the same critical section; a
  single `UPDATE ... WHERE` cannot express "and also do these other
  consistent things," but a transaction holding a row lock composes
  naturally with additional statements before `COMMIT`.
- **Every connection-per-attempt in this lab is deliberately expensive to
  demonstrate the race clearly.** A production reservation endpoint would
  never open a bespoke connection per request just to run a single
  conditional `UPDATE` - it would use a normal pooled connection, since the
  conditional write needs no special connection lifetime. The row-lock
  version genuinely does need to hold one connection per in-flight
  reservation attempt for the duration of its transaction, which is real
  ammunition for preferring the conditional write at scale.
- **A reservation token is not a distributed lock.** It's just a value
  stored on the row (`reservation_token`) that the buyer must present back to
  complete payment - the invariant it protects (only the token-holder can
  complete this specific reservation) is enforced by the same conditional
  `WHERE` mechanism as everything else in this lab, not by any external
  coordination.
- **The expiration worker and payment do not need to agree on ordering.**
  Both are independent conditional UPDATEs against the same row's current
  state; as SPEC.md's "Coordination vs correctness" distinction puts it,
  this invariant belongs to Postgres, not to making sure a background job
  runs before an HTTP request.

## Production notes

1. **What guarantee does this technique provide?** A conditional `UPDATE`
   (or `SELECT ... FOR UPDATE` + `UPDATE`) guarantees that at most one
   concurrent attempt against the same seat transitions it out of
   `AVAILABLE` - this lab's tests assert exactly 1 success out of 100
   concurrent attempts, every run.
2. **What does it not guarantee?** Business correctness beyond the state
   machine itself (e.g. it does not stop an application bug from reserving
   the wrong seat), or that the *caller* who "lost" the race ever learns
   about it in a timely way if the HTTP response is itself lost - that's an
   idempotency/retry problem (Lab 15), not a concurrency-control problem.
3. **What breaks under process crash?** A crash after a conditional `UPDATE`
   commits is fine - the reservation is durable and will simply expire like
   any other reservation if payment never completes. A crash mid-transaction
   in the row-lock version releases the lock automatically (Postgres rolls
   back an open transaction whose connection drops), so a crashed reservation
   attempt never leaves the seat stuck locked.
4. **What breaks under network partition?** Not applicable yet - single
   Postgres node, no replicas (see Lab 24+). A partition between the
   application and Postgres mid-transaction behaves like a process crash from
   Postgres's point of view.
5. **What changes at high contention?** The conditional write's 99 "losers"
   in this lab's benchmark each did one fast round-trip with no blocking; the
   row lock's 99 losers each opened a transaction and waited on the lock
   before losing - under much higher contention (thousands of concurrent
   attempts on one wildly popular seat), the row lock's queuing behavior
   becomes the throughput bottleneck first.
6. **What changes with multiple regions?** Not applicable yet - all of this
   lab's guarantees are single-node. A multi-region ticketing system would
   need the seat's authoritative row to live in one place (or be sharded by
   event/venue) rather than trying to arbitrate reservations across regions.
7. **What metrics would you monitor?** Reservation conflict rate (rejected /
   total attempts - a proxy for how "hot" a given seat/event is), count and
   age of `RESERVED` rows whose `reserved_until` has already passed (should
   be near-zero if the expiration worker is running on schedule - a growing
   number means the worker is falling behind or not running), and payment
   completion rate against reservations that haven't yet expired.
8. **What simpler alternative could be used?** None, for the specific
   single-row invariant this lab protects - the conditional write is already
   the simplest correct mechanism. Redis (SPEC.md's own framing for this
   lab) can reduce read load or speed up "is this seat still available?"
   checks shown to a browsing user, but the actual booking invariant - who
   gets to hold the seat - still has to be adjudicated by whichever store is
   authoritative, which should remain Postgres.
9. **When should you avoid this technique?** Avoid the row-lock variant when
   a reservation is a single-row transition with no other writes that need
   to happen atomically with it - the conditional write does the identical
   job with less held state. Avoid holding a `FOR UPDATE` lock across any
   slow operation (an external API call, a sleep) - it turns a fast row
   lock into a long-held one that blocks every other concurrent attempt for
   that duration.

## Interview questions

1. Why is `rowCount` from the naive version's `UPDATE` statement completely
   uninformative about whether the reservation was actually safe?
2. Walk through why a single `UPDATE ... WHERE id = $1 AND status =
   'AVAILABLE'` needs no `BEGIN`/`COMMIT` to be safe under 100 concurrent
   callers, when the naive version's `SELECT` + `UPDATE` is unsafe even
   though each of its two statements is individually correct.
3. When would `SELECT ... FOR UPDATE` be the better choice over a
   conditional `UPDATE`, given the conditional write is cheaper and never
   blocks anyone?
4. Why is `reserved_until > now()` checked directly inside `complete-
   payment.ts`'s `UPDATE`, instead of relying on `expire-reservations.ts`
   having already reverted the seat to `AVAILABLE` first?
5. This lab models a reservation's state as columns on the `seats` row
   rather than a separate `reservations` table. What would change about the
   fix if a reservation needed to span multiple seats (e.g. "reserve these 4
   seats together, or none")?
6. SPEC.md notes "Redis may improve speed or reduce load, but the database
   must still protect the booking invariant." What, specifically, would a
   Redis-based "seat lock" fail to protect against that this lab's
   conditional `UPDATE` protects against automatically?
7. Why does increasing the artificial delay in `naive-reservation.ts` make
   the race more reliably observable, and why should a fix never rely on
   *removing* delays like this to "solve" a concurrency bug?

## Further experiments

- Change `ARTIFICIAL_DELAY_MS` in `naive-reservation.ts` to `0` and run
  `pnpm scenario:naive` several times - see how much less reliably (though
  usually still detectably) the race reproduces with the delay removed but
  the one-connection-per-attempt structure kept.
- Increase `ATTEMPTS` in the conditional-write and row-lock tests from 100 to
  1,000 (raising `max_connections` further if needed) and compare wall-clock
  time between the two mechanisms - the row lock's per-attempt transaction
  overhead should show up as the gap grows.
- Add a `sections`/`inventory` counter table and extend the row-lock scenario
  to decrement it in the same transaction as the seat reservation - this is
  the concrete case where the row lock's "composes with other statements"
  advantage over the conditional write becomes real, not just theoretical.
- Race `expire-reservations.ts` against `complete-payment.ts` directly:
  reserve a seat with a very short hold (e.g. 1 second), sleep past
  expiration, then fire both a worker tick and a payment attempt
  concurrently and confirm exactly one of the two conditional UPDATEs ever
  matches.
- Add a sixth scenario that cancels an active reservation early (buyer backs
  out) via the same `RESERVED -> AVAILABLE` conditional-UPDATE shape as
  expiration, and write a test proving a cancel and a payment attempt racing
  the same reservation can never both succeed.
