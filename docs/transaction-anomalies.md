# Transaction Anomalies

A quick-reference glossary of the SQL-standard transaction anomalies, cross-
referenced to the labs that reproduce each one against a real running
PostgreSQL instance with real captured output. This file gives the one-
paragraph definition and the PostgreSQL-specific fact that matters; the
linked lab's README has the full reproduction, the fix, and the tradeoffs.

## Dirty read

Reading another transaction's **uncommitted** write.

**Not possible in PostgreSQL at any isolation level**, including a session
that explicitly requests `READ UNCOMMITTED` - Postgres accepts the syntax
and silently maps it onto Read Committed's machinery, because MVCC
visibility is checked against a tuple's commit status, not against the
reader's isolation level. There was never a genuinely weaker
"see-uncommitted-data" code path to select. See `labs/06-mvcc-and-visibility`
(the visibility mechanism) and `labs/07-isolation-read-committed` (the
direct `READ UNCOMMITTED`-vs-`READ COMMITTED` A/B comparison, real captured
output showing identical behavior under both requested levels).

## Non-repeatable read

Two identical reads of the same row, inside the same still-open
transaction, return two different values because another transaction
committed a change in between.

This is the **documented, expected** behavior of Read Committed (Postgres's
default): each *statement* gets a fresh snapshot, not each *transaction*.
Repeatable Read (see below) exists specifically to remove this by taking one
snapshot for the whole transaction instead. See
`labs/07-isolation-read-committed` for a real captured run (`firstRead:
2000000` -> `secondRead: 2025000`, same open transaction, no commit/rollback
in between) and `labs/08-repeatable-read-and-snapshots` for the same setup
under Repeatable Read, where the second read matches the first instead.

## Phantom read

A repeated *range* query (`WHERE amount > 100`, for example) returns a
different SET of rows on a later read within the same transaction, because
another transaction inserted or deleted a row that newly matches (or no
longer matches) the predicate.

Distinct from a non-repeatable read: a non-repeatable read is about one
already-known row's value changing; a phantom is about the row SET itself
changing. Repeatable Read's single per-transaction snapshot prevents this
the same way it prevents non-repeatable reads - a row that didn't exist
(as far as the snapshot is concerned) at transaction start never appears,
no matter when it was actually inserted. Not given a dedicated scenario
script in this repository (the mechanism is the same snapshot Lab 08
already demonstrates for single-row reads), but the isolation-level
guarantee is exactly Lab 08's subject.

## Lost update

Two transactions each read the same row, each compute a new value from what
they read, and the second one to write silently overwrites the first's
intent - with no error, no constraint violation, and every individual
statement completely valid.

Prevented by making the write conditional on the row still looking like
what was read - either a row lock taken at read time
(`SELECT ... FOR UPDATE`, see `labs/10-row-locks-and-select-for-update`) or
a conditional write checked against a version column or business column at
write time (`UPDATE ... WHERE version = ?`, see
`labs/11-conditional-writes-and-optimistic-concurrency`). Real captured
example: two withdrawals from the same $10,000.00 balance, no lock, produce
a final balance of $8,000.00 instead of the correct $5,000.00 - one entire
withdrawal vanishes.

## Write skew

Two transactions each read a *different* row, each correctly conclude "my
change is safe given what I just read," and both commit - jointly violating
a business invariant that spans both rows, even though neither transaction
did anything wrong relative to its own snapshot.

Repeatable Read's same-row conflict check (the mechanism behind the lost-
update fix above) never fires here, because neither transaction ever
touches the row the other one wrote to - the row-version check is
inherently single-row. Real captured example (`labs/08-repeatable-read-and-
snapshots`): two on-call doctors, each sees the other still on call, both go
off call, `finalOnCallCount: 0`. Fixed either by locking every row the
invariant depends on (`SELECT ... FOR UPDATE` on both rows, still at
Repeatable Read) or by upgrading to Serializable (next entry). See
`labs/09-serializable-and-retries` for the full treatment.

## Serialization failure and retry

Under **Serializable** isolation, Postgres tracks read/write dependencies
between concurrently-committing transactions and aborts one of them with
`SQLSTATE 40001` ("could not serialize access due to ...") when it detects
a "dangerous structure" - a cycle of rw-antidependencies that write skew (or
certain same-row conflicts) requires. This is Serializable Snapshot
Isolation (SSI): unlike a row lock, no lock is taken up front; the conflict
is discovered late, at commit time, which is exactly why a Serializable
transaction must always be prepared to retry the whole thing from scratch on
`40001` - the guarantee is worthless without a retry loop that re-reads
fresh state on every attempt. See `labs/09-serializable-and-retries` for the
retry loop, a measured contention/throughput cost under concurrent load, and
the real captured `40001` for the identical write-skew scenario above.

## Concurrent write conflict (same-row, Repeatable Read)

Distinct from write skew: two Repeatable Read transactions racing to
`UPDATE` the *same* row (not two different rows) are caught by a narrower,
cheaper check - Postgres detects that the row changed since the
transaction's own snapshot and aborts the second writer with `SQLSTATE
40001` ("could not serialize access due to concurrent update"). This is
Repeatable Read's own built-in protection, not Serializable's SSI - it never
touches a different row's invariant, only the literal row being written.
See `labs/08-repeatable-read-and-snapshots`.

## See also

- `docs/lock-reference.md` - row and table lock modes, `pg_locks`, advisory
  locks, deadlocks.
- `docs/replication-reference.md` - anomalies specific to reading from a
  replica (staleness, not one of the anomalies above).
- `labs/06-mvcc-and-visibility` through `labs/09-serializable-and-retries` -
  the full progression this file summarizes.
