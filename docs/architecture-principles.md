# Architecture Principles

These principles recur across every lab in this repository. When a lab's README
and this document appear to disagree, the lab's own tradeoffs section wins for
that lab's specific scenario - this document describes the default stance.

## 1. Keep guarantees close to the data

If a correctness invariant belongs to the datastore, enforce it in the
datastore (unique constraint, `CHECK`, transaction, row lock, isolation level)
before reaching for application-level or cross-process coordination.

## 2. Coordination vs correctness

Distributed locks (advisory locks, Redis leases) coordinate *actors* - they
decide who gets to act. Database constraints and transactions protect *data* -
they decide what state is allowed to exist. A lock without a backing
constraint can still let two processes corrupt an invariant if one of them
never acquired the lock (e.g. a bug, a bypassed code path, a second
application). Prefer the constraint; use the lock only for the coordination it
actually buys (throughput, avoiding duplicate work).

## 3. Reservation vs locking

A reservation is business state (`RESERVED`, expires at `T`). A lock is a
concurrency mechanism used, if at all, to safely transition that state. Do not
conflate "the seat is locked" with "the seat is reserved" - the former is
usually milliseconds, the latter is usually minutes.

## 4. Cache vs source of truth

A cache (Redis, in-process) improves latency and reduces load. It is not
authoritative for invariants like "exactly one successful reservation" unless
a lab is specifically exploring that tradeoff. PostgreSQL remains the source
of truth for money- and inventory-shaped invariants in this repository.

## 5. Retry vs idempotency

Retries improve availability under transient failure. Retries without
idempotency turn a transient failure into a duplicated side effect (double
charge, double email, double shipment). Every lab that introduces retries
must also address how the retried operation is made safe to repeat.

## 6. Replication vs consistency

Read replicas improve read scalability and locality. They introduce
staleness. A lab that adds a replica must show the staleness, not just the
scalability.

## 7. ORM vs database

Drizzle exists to make everyday application code less repetitive. It does not
replace understanding transactions, locks, isolation levels, indexes, or
execution plans. Labs pair Drizzle code with the equivalent raw SQL whenever
the SQL is the point of the lesson.

## 8. IDs: internal numeric + external UUID

Where a lab models an API-facing entity, prefer:

```text
id           bigint identity   -- internal, used for joins and advisory-lock keys
public_id    uuid              -- exposed externally
```

Numeric IDs are cheaper to index and join, and can be hashed or used directly
as advisory-lock keys. UUIDs avoid leaking sequential internal identifiers and
avoid collisions across systems that generate IDs independently (e.g. before
an insert commits).
