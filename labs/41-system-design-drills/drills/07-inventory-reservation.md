# Drill 07 - Inventory reservation

## Prompt

Design an inventory reservation system for an e-commerce checkout: when a
customer adds items to a cart and begins checkout, the requested quantity
of each SKU must be held so it cannot be sold to someone else, but never
below zero units and never more than physically exist. A cart can contain
multiple SKUs. If checkout fails (payment declines, customer abandons),
held inventory must be released. Popular SKUs (flash sales) see extreme
concurrent contention on the same rows.

Do your own prediction before reading on.

## Model answer

### 1. Invariants

- For every SKU, `reserved + sold <= quantity` holds at all times - the
  system never lets total commitments exceed physical stock.
- A reservation hold that is abandoned (expired, or its checkout failed)
  is released back to available exactly once - not left stuck forever,
  and not released twice in a way that could double-count availability.
- Reserving multiple SKUs for one cart either all succeed or all roll
  back together - a cart should never end up holding some of its items
  and failing silently on the rest with no compensating release.

### 2. Consistency requirements

**Strong** for the reservation/release transition itself on each SKU
row - this is the same "single-row/quantity invariant under contention"
shape Lab 11/12 both address, just with a quantity delta instead of a
single-row state flag. **Strong within one cart's multi-SKU reservation**
(all-or-nothing) via a transaction, and **compensating, not
transactional,** across the later checkout/payment step - a saga, not one
giant cross-service transaction, since payment capture is a separate
system.

### 3. Storage choice

Postgres. Numeric internal IDs for SKUs used for both joins and lock
ordering (see the deadlock-avoidance mechanism below), with a public
UUID exposed at the API boundary - the same internal-bigint/external-
UUID split Lab 02's own payroll exercise establishes generally. A `CHECK
(reserved + sold <= quantity)` constraint on the inventory row itself
(Lab 02's own constraint-modeling exercise) is defense-in-depth beneath
the application-level conditional write below - even a bug that bypasses
the intended write path cannot commit a physically impossible row.

### 4. Concurrency mechanism

**Reserving a quantity against a SKU under contention**: a conditional
write generalized from Lab 11's version-check pattern into a quantity
check - `UPDATE inventory SET reserved = reserved + ? WHERE id = ? AND
quantity - reserved - sold >= ?` - rather than a naive read-then-write
(read current availability in application code, then issue an
unconditional `UPDATE`), which is precisely the lost-update shape Lab 11
proved happens in practice: two concurrent naive updates on the same row
both reported `rowCount: 1`, and only the later write survived,
silently discarding the earlier one. The conditional `UPDATE`'s `WHERE`
clause makes the check-and-decrement atomic in a single statement rather
than two round trips, so a losing writer gets `rowCount: 0` back
immediately and can retry or fail the reservation cleanly, exactly the
guarantee Lab 11 demonstrates.

**Alternative for extremely hot single-SKU contention where retry-after-
`rowCount:0` logic is inconvenient**: `SELECT ... FOR UPDATE` on the
inventory row before checking and updating in application code - Lab 10's
row-lock mechanism, which Lab 10 showed genuinely blocks a second writer
(a real measured 261-263ms wait) until the first writer's transaction
resolves, so the second writer's subsequent read reflects the first
writer's committed change rather than stale data. Either mechanism is
correct here (this is the same pessimistic-vs-optimistic choice Lab 11's
own README frames explicitly); the conditional write is generally
preferred for a hot single-row quantity check because a loser fails
immediately with no lock-wait latency, which matters more under flash-
sale-scale contention on one SKU than it does for the multi-SKU cart case
below.

**Reserving multiple SKUs for one cart without deadlocking**: when a
checkout must lock more than one inventory row (e.g. via `FOR UPDATE`
rather than pure conditional writes, or when the conditional-write
retries themselves acquire row locks internally), always acquire the
locks in a fixed, deterministic order (e.g. sorted by SKU's internal
numeric `id`) regardless of the order items appear in the cart - exactly
Lab 32's fix. Lab 32 built the textbook two-transaction deadlock (A
locks row 1 then wants row 2; B locks row 2 then wants row 1) and
reproduced a real, Postgres-detected `SQLSTATE 40P01` deadlock
identically across repeated runs; switching both transactions to acquire
locks in the same order (`Math.min`/`Math.max` of the two IDs in Lab
32's case, sorted SKU IDs here) measured 0 deadlocks across 100
concurrent trial pairs, versus 100/100 deadlocks under inconsistent
ordering. A multi-item checkout that locks SKUs in cart-insertion order
is exactly the inconsistent-ordering setup Lab 32 built to demonstrate
the failure.

**Releasing an abandoned or expired hold**: the same conditional-write-
based expiry-worker pattern Lab 12 uses for seat-reservation expiry -
`UPDATE inventory SET reserved = reserved - ? WHERE ... AND
reservation_expires_at < now()` - naturally idempotent against being run
more than once on an already-released hold, since a second run's `WHERE`
clause matches nothing.

**Compensating a failed checkout across the reservation-and-payment
sequence**: a saga, Lab 20's exact pattern
(`ReserveInventory -> CapturePayment -> ...`, with `ReleaseInventory` as
the compensating action if a later step fails) - Lab 20 measured this
concretely, not just as a flag flip: a forced failure after payment
capture triggered `refundPayment`/`releaseInventory`/`cancelOrder` in
reverse order and restored the real inventory count exactly (e.g. 90
units back to 90), proven identical whether implemented as orchestration
(one coordinator calling every compensating step) or choreography (an
event bus with each service reacting to the event immediately before
it) - Lab 20's own real captured trace-complexity numbers (5
observability-log rows/0 named actors for orchestration versus 13
rows/4 actors for choreography on the identical happy path) are the
direct evidence for orchestration being easier to trace for a workflow
this size, without either approach being "more correct."

### 5. Failure modes

- **Two concurrent checkouts try to reserve the last unit of a hot SKU**:
  the conditional write's `WHERE quantity - reserved - sold >= ?` clause
  makes exactly one of them succeed; the loser sees `rowCount: 0` and
  fails cleanly (Lab 11's mechanism), never oversold.
- **A multi-item cart's reservation partially succeeds** (SKU A reserved,
  SKU B's `UPDATE` returns `rowCount: 0` because it sold out mid-
  checkout): the whole reservation happens inside one transaction, so a
  failed SKU B reservation rolls back SKU A's reservation too - the "all
  or nothing" invariant from a single database transaction, not
  application-level compensation.
- **A checkout that reserved multiple SKUs in inconsistent lock order
  deadlocks with a concurrent checkout doing the reverse**: prevented
  entirely by the consistent-lock-ordering fix (Lab 32), not merely
  recovered from - Lab 32 explicitly distinguishes prevention (this
  case) from recovery via retry-on-deadlock (a different, valid
  strategy Lab 32 also demonstrates, at the cost of at least one wasted
  attempt per real deadlock).
- **Payment is captured but a downstream step (e.g. shipment creation)
  fails**: the saga's compensating chain (Lab 20) releases the
  inventory and refunds the payment, restoring the invariant exactly,
  not approximately.
- **The reservation-expiry worker and a payment completion race on the
  same hold**: both operations are conditional writes keyed on current
  state (Lab 12's own reasoning applies unchanged), so whichever commits
  first wins and the other's `WHERE` clause simply matches nothing.

### 6. Scale estimate

Flash-sale-scale contention on one SKU behaves like Lab 12's own
100-concurrent-attempt seat-reservation benchmark (conditional writes
correctly reduce 100 concurrent attempts to exactly the number the
`WHERE` clause allows to succeed) rather than like Lab 14's `SKIP
LOCKED` job-queue numbers, because this is contention on one specific
row's value, not competition for one of many interchangeable claimable
rows - the conditional write pays no blocking-wait cost for losers
(immediate `rowCount: 0`), which is exactly the property that matters at
this scale.

### 7. Observability

- Per-SKU `pg_locks`/`pg_stat_activity` during a known hot window (Lab
  10's own inspection queries), to see real contention depth on specific
  rows rather than only aggregate success/failure counts.
- A `reserved`/`available`/`sold` gauge per SKU, and a reservation-
  expiry-worker lag metric (age of the oldest still-held, past-expiry
  reservation it has not yet processed).
- Saga step and compensation counts (Lab 20's own `saga_log`-style
  observability table), so a spike in compensating actions (releases
  triggered by payment failures, not by normal expiry) is visible as its
  own signal.

## Common wrong answer

**"Keep the authoritative available-quantity count in Redis (a single
`DECR`) for speed, and sync it back to Postgres asynchronously."** This
conflates a cache with a source of truth, exactly the distinction
CLAUDE.md's Learning Philosophy states directly ("Redis may improve
latency and throughput. PostgreSQL remains authoritative for critical
booking/payment invariants"). A `DECR` in Redis is fast, but it is not
transactional with the actual order/payment write; a crash or partial
failure between the Redis decrement and the real order record leaves the
two systems disagreeing with no mechanism tying them together
transactionally - there is no `WHERE` clause, no `CHECK` constraint, and
no rollback available in Redis the way there is in Postgres. Lab 21's own
cache-aside pattern is the right role for Redis in an inventory system -
speeding up *read-only* availability lookups on product pages - but Lab
21 never treats the cached value as authoritative for a write-path
decision, and this design should not either. Keep Postgres authoritative
for the reservation transition; use Redis only to reduce read load on
non-authoritative availability display.

## Interview questions

- Walk through what "never oversell" actually means as a `WHERE` clause,
  and explain why a naive read-then-write in application code cannot
  provide the same guarantee even with an explicit application-level
  `if (available >= quantity)` check beforehand.
- A checkout needs to reserve 3 different SKUs at once. Why does lock
  ordering matter here even though each individual SKU's own reservation
  update is itself correct in isolation?
- Compare the compensating `ReleaseInventory` step in this drill's saga
  to the reservation-expiry worker. Are they the same mechanism serving
  two different triggers, or genuinely different mechanisms? Justify
  your answer using Lab 12 and Lab 20's respective evidence.
- Why is a `CHECK` constraint on the inventory row useful even though the
  application-level conditional write is supposed to be the actual
  enforcement mechanism?
- If this system needed to reserve inventory across two independent
  regional Postgres databases for the same SKU (e.g. a globally pooled
  warehouse), what would break about the single-row conditional-write
  approach, and what would you need instead?
