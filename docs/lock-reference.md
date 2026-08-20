# Lock Reference

A quick-reference for PostgreSQL's lock mechanisms, cross-referenced to the
labs that demonstrate each one against a real running instance with real
captured timings and error codes. This file is a lookup table; the linked
lab's README has the full reproduction, the fix, and the tradeoffs.

## Row-level lock modes

Taken by `SELECT ... FOR UPDATE` / `FOR NO KEY UPDATE` / `FOR SHARE` /
`FOR KEY SHARE`, and implicitly by `UPDATE`/`DELETE`. See
`labs/10-row-locks-and-select-for-update`.

| Mode | Taken by | Blocks | Does not block |
|---|---|---|---|
| `FOR UPDATE` | explicit read-then-write intent; any plain `UPDATE`/`DELETE` that touches a `UNIQUE`-indexed column | every other lock mode on the row | nothing |
| `FOR NO KEY UPDATE` | an ordinary `UPDATE` that does **not** touch a `UNIQUE`-indexed column (Postgres picks this automatically) | `FOR UPDATE`, another `FOR NO KEY UPDATE` | `FOR KEY SHARE` |
| `FOR SHARE` | "let many readers depend on this row, block any writer" | any write, `FOR UPDATE`/`FOR NO KEY UPDATE` | another `FOR SHARE` |
| `FOR KEY SHARE` | a foreign-key check on a referencing row | `FOR UPDATE` | `FOR NO KEY UPDATE`, another `FOR KEY SHARE` |

A **plain `SELECT` takes no row lock at all** - that is exactly why readers
never block writers under MVCC (`labs/06-mvcc-and-visibility`). `FOR UPDATE`
exists specifically to change that for a read-modify-write sequence.

**`NOWAIT`** fails immediately (`SQLSTATE 55P03`, `lock_not_available`)
instead of blocking. **`SET LOCAL lock_timeout = '...'`** blocks up to a
bounded duration, then fails with the same `55P03`. Real captured numbers
(`labs/10-row-locks-and-select-for-update`): `NOWAIT` returned in 2ms;
`lock_timeout=500ms` against the same held lock returned in 504ms.

## Table-level lock modes relevant to migrations

Relevant DDL and its lock, from weakest to strongest (see
`labs/29-safe-schema-migrations`):

| Operation | Lock taken | Conflicts with |
|---|---|---|
| `ALTER TABLE ... ADD COLUMN col text` (nullable, no default) | brief `ACCESS EXCLUSIVE`, but the statement itself is a near-instant pure-catalog change regardless of table size | everything, but only for milliseconds |
| `CREATE INDEX` (plain) | `SHARE` | any `ROW EXCLUSIVE` (ordinary writes) - blocks writers for the index build's entire duration |
| `CREATE INDEX CONCURRENTLY` | `SHARE UPDATE EXCLUSIVE` | does **not** conflict with ordinary `ROW EXCLUSIVE` writes; can fail into an `INVALID` index that must be dropped and rebuilt by hand |
| `ALTER TABLE` (most forms, e.g. adding a constraint) | `ACCESS EXCLUSIVE` | every other lock mode, including a plain `SELECT`'s `ACCESS SHARE` |

Real captured numbers: a plain `CREATE INDEX` waited 1957ms behind a
2000ms-held write transaction (never even started building until the
conflicting lock released); `CREATE INDEX CONCURRENTLY` against the
identical held transaction let a third connection's unrelated write
complete in 3ms while the index was still building. An `ALTER TABLE` with
no `lock_timeout` waited 1454ms behind a held conflicting lock; the same
statement with `SET lock_timeout = '500ms'` failed fast at 507ms with
`55P03`.

## `pg_locks` and `pg_stat_activity` - reading who is blocking whom

A blocked row lock shows up in `pg_locks` as a row with `locktype =
'transactionid'`, `granted = false` - it is waiting on the **holder's
transaction id**, not on the table or row directly:

```sql
SELECT blocked.pid AS blocked_pid, blocked.query AS blocked_query,
       blocking.pid AS blocking_pid, blocking.query AS blocking_query
FROM pg_locks blocked_locks
JOIN pg_stat_activity blocked ON blocked.pid = blocked_locks.pid
JOIN pg_locks blocking_locks ON blocking_locks.locktype = blocked_locks.locktype
  AND blocking_locks.transactionid = blocked_locks.transactionid
  AND blocking_locks.granted
JOIN pg_stat_activity blocking ON blocking.pid = blocking_locks.pid
WHERE NOT blocked_locks.granted;
```

(This is `packages/db-utils/sql/show-blocked-queries.sql`, reused unmodified
across `labs/10`, `labs/32`, and `labs/38`.) When two backends are
genuinely deadlocked, this same query - run while both are still waiting,
before Postgres's own detector acts - returns exactly the two edges that
form the cycle (A blocked-by B, B blocked-by A). No special "find the
cycle" query is needed; a longer cycle just shows up as more edges to
follow transitively.

## Deadlocks

A **cycle** in the wait-for graph (A waits for something only B can
release; B waits for something only A can release), as opposed to ordinary
blocking (a **chain**: B waits for A, but A is not waiting on anyone). A
cycle cannot be resolved by waiting longer - Postgres's own background
deadlock detector notices it after `deadlock_timeout` (default 1s) elapses
and aborts one participant (chosen by an internal heuristic) with
`SQLSTATE 40P01`, whose `detail` field literally names the two waiting
processes and what each is blocked on. See `labs/32-deadlocks-and-lock-
debugging`.

**The only real prevention is consistent lock ordering**: if every
transaction that could ever lock two of the same rows always requests them
in the same order (e.g. always the lower id first, regardless of business
direction), a cycle becomes topologically impossible - the second
transaction to arrive may still wait (an ordinary chain), but it can never
be waited on in return. Real measured result: the identical business
scenario deadlocked 100/100 trials under inconsistent ordering and 0/100
under consistent ordering. Retry-on-`40P01` is a **complementary
recovery** mechanism, not prevention - it does not change the probability
that the same cycle forms again on the next conflicting pair of
transactions.

## Advisory locks

An application-defined lock keyed by an arbitrary `bigint` (or a pair of
`int`s), tracked by PostgreSQL but **not tied to any row or table** - it
coordinates cooperating callers, it does not lock data. See
`labs/13-advisory-locks`.

| | Session-level (`pg_advisory_lock`/`pg_try_advisory_lock`) | Transaction-level (`pg_advisory_xact_lock`) |
|---|---|---|
| Released by | an explicit `pg_advisory_unlock` call, or the holding connection disconnecting | automatically at `COMMIT` or `ROLLBACK` - there is no unlock function |
| Best for | a critical section spanning multiple transactions or statements | a critical section that is exactly one transaction |
| Leak risk | a long-lived, still-connected process that forgets to unlock | none - the transaction boundary is the release point |

**Zero protection against a non-cooperating caller**: a connection that
never calls any `pg_advisory_*` function can update the exact row an
advisory lock is "protecting," instantly, while the lock is held - real
captured proof in `labs/13-advisory-locks` (`directUpdateDurationMs: 1`
while the lock was held). Use an advisory lock only when every writer of
the protected data is known to cooperate with the same key; otherwise the
invariant belongs in a row lock, a conditional write, or a unique
constraint instead.

**Blocking (`pg_advisory_lock`) vs. non-blocking
(`pg_try_advisory_lock`)**: blocking queues FIFO like a row lock;
non-blocking returns `false` immediately and is the right shape for a
worker that should skip contended work and move on - compare with `SKIP
LOCKED` below, which achieves a similar goal for row locks instead of
advisory locks.

**Lock-key strategy**: use a stable internal numeric id directly when
available (zero collision risk). When only a UUID is available, hashing it
into a 32-bit key space becomes a real (not just theoretical) collision
risk past roughly 100,000 keys (~69% birthday-paradox collision
probability, measured); a 64-bit key space keeps that risk negligible
(~2.7e-8% at the same scale). A collision only ever costs throughput
(two unrelated keys occasionally contend), never correctness.

## `SELECT ... FOR UPDATE SKIP LOCKED`

Like plain `FOR UPDATE`, but a candidate row that is already locked by
another transaction is **skipped** instead of blocking the whole
statement - the claimant moves on to the next unlocked matching row. This
is what lets many concurrent workers each claim a different row instead of
queuing up behind whichever one locked first. Real measured contrast
(`labs/14-job-queue-skip-locked`): plain `FOR UPDATE` made a second worker
block for the full ~300ms the first worker's transaction stayed open, even
with other candidate rows free; `SKIP LOCKED`'s equivalent claim returned
in 10ms with a different row. See `labs/14-job-queue-skip-locked` for the
full claim-and-lease pattern.

## See also

- `docs/transaction-anomalies.md` - the SQL-standard anomalies row locks
  and isolation levels each protect against.
- `docs/replication-reference.md` - lock behavior is entirely a
  single-primary-node concept; nothing here applies across a replica.
- `labs/10-row-locks-and-select-for-update`, `labs/13-advisory-locks`,
  `labs/14-job-queue-skip-locked`, `labs/29-safe-schema-migrations`,
  `labs/32-deadlocks-and-lock-debugging` - the full reproductions.
