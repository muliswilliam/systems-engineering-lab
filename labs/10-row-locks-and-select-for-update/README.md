# Lab 10 - Row Locks and `SELECT ... FOR UPDATE`

## Why this exists

Lab 07 showed that a plain `SELECT` never blocks and never sees uncommitted
data. That is exactly the problem for a very common pattern: read a row,
decide something in application code based on what you read, then write a
new value back. If two transactions do this concurrently against the same
row, Postgres's default behavior does nothing to stop the second write from
silently erasing the first transaction's decision - this is the "lost
update," and it happens even though every individual statement is completely
valid and every `CHECK` constraint stays satisfied the whole time. `SELECT
... FOR UPDATE` is Postgres's built-in fix: take an explicit row lock at read
time, so a concurrent transaction cannot even finish reading the row it needs
until you are done deciding what to do with it. This lab makes the lost
update happen for real, fixes it with `FOR UPDATE`, and then explores the
sharper tools around it - `FOR SHARE`, `NOWAIT`, `lock_timeout`, and the
`FOR NO KEY UPDATE`/`FOR KEY SHARE` distinction that lets ordinary `UPDATE`s
avoid unnecessary conflicts with foreign-key checks.

## Learning objectives

After this lab you should be able to:

- reproduce a real lost update with two independently-controlled Postgres
  connections, and explain precisely why the row-level lock an `UPDATE`
  always takes does NOT prevent it;
- use `SELECT ... FOR UPDATE` to make a read-modify-write sequence safe, and
  explain what it actually blocks (the read, not just the write);
- distinguish `FOR UPDATE` (exclusive), `FOR SHARE` (shared among readers,
  exclusive against writers), `FOR NO KEY UPDATE`, and `FOR KEY SHARE`, and
  state the real Postgres row-lock compatibility rules between them;
- use `NOWAIT` to fail instantly instead of blocking, and `SET LOCAL
  lock_timeout` to bound how long a blocked statement will wait, and know
  the real SQLSTATE and message Postgres raises for each;
- read `pg_locks` and `pg_stat_activity` while a transaction is genuinely
  blocked, including the `locktype = 'transactionid'` row that represents
  "waiting for someone else's transaction to finish," not just the
  relation-level lock rows.

## Architecture

```text
┌────────────────────────────┐         ┌──────────────────────┐
│ src/scenarios/              │         │                      │
│  lost-update-without-lock   │────────▶│                      │
│  select-for-update          │────────▶│      PostgreSQL      │◀── pgweb
│  nowait-and-lock-timeout    │────────▶│      (accounts)      │    (browser UI)
│  lock-modes                 │────────▶│                      │
│  (raw pg.Client connections,│         │                      │
│   BEGIN/SELECT.../COMMIT)   │         └──────────────────────┘
└────────────────────────────┘                    ▲
                                            seed.ts / migrate.ts
```

Domain: a deliberately minimal **banking/ledger**-flavored slice (SPEC.md
ยง8.2) - a single `accounts` table with a mutable `balance_cents` column and a
`CHECK (balance_cents >= 0)`. This lab is about row-locking *mechanics*, not
a rich relational model, so one row with a withdrawal story is enough to
drive every experiment. This schema is defined independently of Lab 05's
`accounts` (transactional atomicity) and Lab 07's `accounts` (isolation
levels) - none of the three tables are shared, and this lab does not import
from either.

Every scenario uses two (sometimes three) independent `pg.Client` connections
driven with raw SQL (`BEGIN`, `SELECT ... FOR UPDATE`, `UPDATE`, `COMMIT`/
`ROLLBACK`), never Drizzle's query builder - see `src/scenarios/support.ts`.
Per CLAUDE.md's "ORM plus SQL" rule, an interleaved multi-transaction
experiment needs explicit control over exactly when each connection issues
each statement, and needs the connection's backend PID to scope `pg_locks`
snapshots precisely - a query builder does not model either well.

## Setup

```bash
pnpm install
cp labs/10-row-locks-and-select-for-update/.env.example labs/10-row-locks-and-select-for-update/.env
cd labs/10-row-locks-and-select-for-update
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate
pnpm seed
```

Open PGweb at http://localhost:8410 (it auto-connects via
`PGWEB_DATABASE_URL`). You should see an `accounts` table with 4 fixed
"Scenario Account - ..." rows plus a handful of faker-generated "browsing"
accounts.

## Scenario

An account has a balance. Two withdrawal requests arrive for the same
account at nearly the same time (two ATM withdrawals, two API requests, two
background workers - the transport doesn't matter). Each request reads the
current balance, checks it can cover the withdrawal, and writes back the new
balance. What happens to the balance if both requests are in flight at once?

## Prediction

Before running anything, predict:

1. Two transactions both read a $10,000.00 balance with a plain `SELECT` (no
   lock). Transaction A withdraws $3,000.00, transaction B withdraws
   $2,000.00. Both write their independently-computed new balance back. What
   is the final balance - $5,000.00 (both withdrawals reflected), $7,000.00
   (only A), or $8,000.00 (only B)?
2. Does Postgres's row-level lock (which every `UPDATE` always takes,
   `FOR UPDATE` or not) prevent the outcome in question 1? Why or why not?
3. If both transactions instead do `SELECT ... FOR UPDATE` before deciding
   anything, does transaction B's `SELECT` itself block, or only its later
   `UPDATE`?
4. `SELECT ... FOR UPDATE NOWAIT` against an already-locked row: does it
   wait a short time and then fail, or fail instantly?
5. Can two different transactions hold `FOR SHARE` on the same row at the
   same time? Can one hold `FOR SHARE` while another holds `FOR UPDATE`?
6. An `UPDATE` that only changes a non-unique column like `owner_name` - does
   it take the same lock strength as an `UPDATE` that changes a `UNIQUE`
   column like `public_id`?

## Exercise

1. Run the setup commands above.
2. Run `pnpm scenario:lost-update` and read the log output - it logs both
   transactions' stale reads, both computed "new" balances, a real captured
   `pg_locks`/`pg_stat_activity` snapshot while transaction B's `UPDATE` is
   blocked on transaction A's still-open transaction, and the final
   (wrong) balance.
3. Run `pnpm scenario:select-for-update` and compare - the same two
   withdrawals, but this time the final balance is correct.
4. Run `pnpm scenario:nowait-lock-timeout` and read the two real Postgres
   errors it captures: `NOWAIT`'s instant `55P03` and `lock_timeout`'s
   `55P03` after the configured wait.
5. Run `pnpm scenario:lock-modes` and read the four mini-demos: concurrent
   `FOR SHARE` readers, `FOR UPDATE` blocking a `FOR SHARE`, and the
   `FOR KEY SHARE` vs `FOR NO KEY UPDATE` asymmetry.
6. Run `pnpm test` and read the assertions - they check actual balances,
   actual SQLSTATEs, and bounded (not precise) wait times, not ordering.

## Observe

- **PGweb** (http://localhost:8410): browse `accounts` after each scenario
  run and watch `balance_cents` settle at the post-scenario value for each
  "Scenario Account - ..." row.
- **`docker compose logs postgres`**: with `log_statement=all`, you can see
  the exact `BEGIN`, `SELECT ... FOR UPDATE`, `UPDATE`, and `COMMIT`
  statements each scenario sent, interleaved between connections by
  timestamp.
- **`pg_locks` / `pg_stat_activity`**: every scenario logs a real snapshot
  (via `src/scenarios/support.ts`'s `snapshotLocks`, adapted from
  `packages/db-utils/sql/show-locks.sql`) captured at the moment a connection
  is genuinely blocked - see "Real validation run" below for actual captured
  rows.
- **Structured logs**: every scenario logs through `@labs/logging` (Pino),
  including `accountId`, the exact balances read/computed, real elapsed
  block times in milliseconds, and a final boolean verdict field
  (`lostUpdateOccurred`, `bothWithdrawalsCorrectlyReflected`,
  `raisedImmediately`, `abortedAfterTimeout`).

## Break it

Run `pnpm scenario:lost-update` and look at a real captured run:

```text
transaction A: plain SELECT (no lock)         balanceReadByA=1000000
transaction B: plain SELECT (no lock)         balanceReadByB=1000000
transaction A: UPDATE (not yet committed)     newBalanceComputedByA=700000
transaction B: UPDATE issued - BLOCKS on A's still-open transaction
  ...B's UPDATE waits (bUpdateBlockedMs=263)...
transaction A: COMMIT
transaction B: UPDATE unblocks, applies newBalanceComputedByB=800000
finalBalanceCents=800000   correctBalanceCents=500000   lostUpdateOccurred=true
```

Both transactions read the same $10,000.00 baseline. A computes "withdraw
$3,000 → $7,000" and B computes "withdraw $2,000 → $8,000". A's `UPDATE`
commits first. B's `UPDATE` was genuinely BLOCKED - Postgres's row-level
lock for `UPDATE` is real and always applies, whether or not you asked for
`FOR UPDATE` - but blocking only delays B's write, it does not make B
recompute anything. The instant A commits, B's queued `UPDATE` runs and
overwrites the row with `$8,000` - a value computed before A's withdrawal
even happened. The final balance is `$8,000.00`, not the correct `$5,000.00`
(baseline minus BOTH withdrawals). A's entire withdrawal has vanished, with
no error, no rollback, and no CHECK-constraint violation anywhere - every
individual statement was completely valid.

## Fix it

`pnpm scenario:select-for-update` runs the identical two withdrawals, with
one change: each transaction reads the balance with

```sql
SELECT balance_cents FROM accounts WHERE id = $1 FOR UPDATE;
```

Real captured run:

```text
transaction A: SELECT ... FOR UPDATE          balanceSeenByA=1000000
transaction B: SELECT ... FOR UPDATE issued - BLOCKS (this is the READ, not just the write)
  ...B's SELECT waits (bSelectBlockedMs≈260)...
transaction A: applies withdrawal, UPDATE, COMMIT
transaction B: FOR UPDATE unblocks, balanceSeenByB=700000  (A's POST-withdrawal balance)
transaction B: applies its withdrawal against the CURRENT balance, UPDATE, COMMIT
finalBalanceCents=500000   correctBalanceCents=500000   bothWithdrawalsCorrectlyReflected=true
```

The critical difference from the naive version: B's `FOR UPDATE` SELECT
itself blocks, so B cannot even see a balance to make a decision from until
A's transaction is fully resolved. When B finally reads the balance, it sees
`$7,000.00` (A's result), not the stale `$10,000.00`. B's withdrawal is
computed against current data, so the final balance correctly reflects both
withdrawals: `$5,000.00`. A second test case in `tests/integration/select-
for-update.test.ts` also drives an amount that would overdraw the
post-A balance - `outcomeB.applied` comes back `false` with
`reason: "insufficient_funds"`, and the balance never goes negative, proving
this lab's second required outcome (correct rejection) as well as the
correct-application-of-both-withdrawals outcome.

## Why the fix works

A plain `SELECT` never takes a row lock in Postgres - that is precisely why
readers never block writers under MVCC (Lab 06). `FOR UPDATE` changes that:
it makes the `SELECT` itself acquire the same row-level lock an `UPDATE`
would take, for the duration of the transaction. A second transaction's
`FOR UPDATE` SELECT on the same row has to wait for that lock, which means
it cannot proceed to its own decision logic until the first transaction
commits or rolls back. This closes the exact gap that produces a lost
update: there is no longer a window where two transactions can both read the
"old" value and both compute a "new" value from it, because the second
transaction's read is delayed until there is no old value left to read - only
the current, post-first-transaction value.

The `pg_locks` snapshot captured mid-block (see below) shows the mechanism
directly: the blocked connection is waiting on a `locktype = 'transactionid'`
row (`mode: ShareLock, granted: false`) - it is not waiting on the `accounts`
table itself, it is waiting for permission to know whether the FIRST
transaction's ID (which owns the row's exclusive tuple lock) has committed
or aborted yet. That is what "waiting for a row lock" concretely is in
Postgres: waiting to be notified that a specific transaction ID has finished.

## Tradeoffs

- **`FOR UPDATE` vs a plain read-modify-write**: `FOR UPDATE` closes the lost
  update at the cost of real blocking - a busy row now serializes every
  concurrent updater, one at a time, for as long as each transaction stays
  open. Keep these transactions short.
- **`FOR UPDATE` vs a conditional write (`UPDATE ... WHERE balance_cents =
  $expected`, Lab 11)**: a conditional write never blocks - it always
  succeeds or fails immediately, and a failure means "someone else changed
  it, retry" instead of waiting. `FOR UPDATE` is often clearer to reason
  about for multi-step decisions (like this lab's insufficient-funds check),
  while conditional writes usually give higher throughput under contention
  since nobody queues up waiting.
- **Blocking (`FOR UPDATE`) vs `NOWAIT` vs `lock_timeout`**: plain
  `FOR UPDATE` waits indefinitely (`lock_timeout` defaults to `0`, meaning
  "forever") - fine for short, fast transactions, dangerous if the lock
  holder can hang (a stuck connection, an accidental long-running
  transaction) because every waiter queues up behind it with no bound.
  `NOWAIT` trades "correctness under contention" for "fail fast, let the
  caller decide" (retry with backoff, return a 409, queue the request) - it
  never ties up a connection waiting. `lock_timeout` is a middle ground:
  wait up to a bounded budget, then fail the same way `NOWAIT` does but with
  a chance to succeed if the lock clears quickly.
- **`FOR SHARE` vs `FOR UPDATE`**: `FOR SHARE` lets many transactions read
  and depend on a row concurrently (e.g., "these seats are being considered,
  don't let anyone delete or resize this row out from under any of us")
  without serializing them against each other - but it still fully blocks
  any writer, so it is not a substitute for `FOR UPDATE` when you intend to
  write.
- **Ordinary `UPDATE` choosing `FOR NO KEY UPDATE` automatically**: this
  reduces false contention against `FOR KEY SHARE` locks taken by foreign
  key checks elsewhere in the schema, entirely automatically - you do not
  choose this lock strength yourself for a plain `UPDATE`. The cost is
  subtlety: an `UPDATE` that touches a `UNIQUE`-indexed column silently
  upgrades to the stronger `FOR UPDATE`, which can surprise you with more
  contention than an equivalent `UPDATE` on a non-indexed column.

## Production notes

1. **What guarantee does this mechanism give?** `SELECT ... FOR UPDATE`
   guarantees that once your transaction's `SELECT` returns, no other
   transaction can concurrently hold a conflicting lock on that row (another
   `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE`, or a normal `UPDATE`/
   `DELETE`) until you commit or roll back - your decision, based on that
   read, cannot be invalidated by a concurrent writer before you act on it.
2. **What does it not guarantee?** It does not protect against reading a row
   with `FOR UPDATE` in one transaction while forgetting to lock a RELATED
   row your business logic also depends on (e.g., a multi-row invariant
   spanning two accounts) - that needs either locking every row involved, or
   Serializable isolation (Lab 09). It also does not prevent a deadlock if
   two transactions lock the same two rows in opposite orders (Lab 32).
3. **What breaks under process crash?** If the process holding the lock
   crashes with the transaction still open (not just the client
   disconnecting), Postgres detects the dead connection and releases the
   lock - but if the process is merely *hung* (not crashed, not
   disconnected), the lock is held indefinitely and every waiter queues up
   behind it. This is exactly what `lock_timeout` protects against.
4. **What breaks under network partition?** Not applicable here - single
   Postgres node, no replicas yet (see Lab 24+). A client that loses its
   network connection to Postgres has its session/transaction terminated by
   the server, which releases the lock.
5. **What changes at high contention?** Every waiter forms a queue behind
   the lock holder - throughput on a hot row degrades to roughly
   "one transaction's worth of work per lock-hold duration," no matter how
   many CPUs or connections are available. This is the scenario Lab 12's
   ticket-reservation system and Lab 14's `SKIP LOCKED` job queue both exist
   to work around for high-contention, high-throughput cases.
6. **What changes with multiple regions?** Not applicable yet - row locks
   are a single-primary-node concept; see the replication labs (24-28) for
   what happens once writes must go to one primary while reads may go
   elsewhere.
7. **What metrics would you monitor?** `pg_stat_activity.wait_event_type =
   'Lock'` counts (how many backends are currently blocked on a lock), lock
   wait duration histograms, and `pg_locks` rows with `granted = false` that
   persist beyond a few seconds - a growing queue of blocked backends on one
   row is an early warning of a hot-row bottleneck.
8. **What simpler alternative could be used?** A conditional write
   (`UPDATE ... WHERE version = $expected`, Lab 11) avoids blocking entirely
   and often scales better under contention, at the cost of needing explicit
   retry logic in the application instead of relying on the database to
   queue writers for you.
9. **When should you avoid this technique?** Avoid `FOR UPDATE` for
   long-running transactions (anything that calls out to a slow external
   service, waits on user input, or does non-trivial computation while
   holding the lock) - the lock is held for the transaction's ENTIRE
   duration, and a slow transaction becomes a bottleneck for every other
   transaction that touches the same row.

## Interview questions

1. Two transactions each do a plain `SELECT` then an `UPDATE` with an
   absolute value computed in application code. Why does Postgres's
   automatic row lock on `UPDATE` fail to prevent a lost update here?
2. What exactly does a blocked `SELECT ... FOR UPDATE` show up as in
   `pg_locks` - and why is the `relation` column `NULL` on the row that
   actually represents the block?
3. When would `NOWAIT` be the wrong choice compared to a plain (blocking)
   `FOR UPDATE`, and vice versa?
4. Why does `lock_timeout` need to be set with `SET LOCAL` rather than
   `SET`, inside the transaction that will do the locking read?
5. Why doesn't `FOR SHARE` block another `FOR SHARE`, but does block a plain
   `UPDATE`?
6. Explain, precisely, why an `UPDATE` that only changes a non-key column
   does not conflict with a `FOR KEY SHARE` lock held by a concurrent
   foreign-key check, while an `UPDATE` that changes a `UNIQUE`-indexed
   column does.
7. When would optimistic concurrency (Lab 11's conditional write) be a
   better fit than `SELECT ... FOR UPDATE` for the same withdrawal problem?

## Further experiments

- In `src/scenarios/lost-update-without-lock.ts`, change the write from an
  absolute value (`balance_cents = $1`) to a relative one
  (`balance_cents = balance_cents - $1`) and predict what happens - the lost
  update disappears even without `FOR UPDATE`, because Postgres recomputes
  `balance_cents` from whatever the CURRENT committed row holds at the
  moment each `UPDATE` actually executes, not from the value either
  transaction read earlier. This is a real, useful fix for simple
  increment/decrement cases, but it does not generalize to decisions more
  complex than "add/subtract a fixed amount" (e.g., "reject if this would
  overdraw" needs to see the current value before deciding, which relative
  updates alone cannot do without a `CHECK` doing the rejecting).
- In `src/scenarios/select-for-update.ts`, pass withdrawal amounts that
  would overdraw the SECOND account after the first withdrawal applies (see
  `playground/notes.md`) and confirm `outcomeB.reason` is
  `"insufficient_funds"`, never a negative balance.
- Add a third concurrent transaction to `lost-update-without-lock.ts` and
  confirm the lost update gets worse (more withdrawals silently vanish), not
  better, with more naive concurrent writers.
- Open two `psql "$DATABASE_URL"` sessions by hand (see
  `playground/notes.md`) and reproduce the blocking behavior one statement at
  a time.
- In `src/scenarios/nowait-and-lock-timeout.ts`, lower `lockTimeoutMs` to
  `50` and confirm `elapsedMs` still comes back `>= 50` but now much closer
  to the smaller budget - `lock_timeout` genuinely bounds the wait, it does
  not fire on a fixed schedule.

## Real validation run (captured output)

The following are actual values captured from a real run against this lab's
Docker Compose stack (not hypothetical/aspirational output).

**`pnpm scenario:lost-update`** (trimmed):

```json
{"accountId":"10","balanceReadByA":1000000}
{"accountId":"10","balanceReadByB":1000000}
{"accountId":"10","newBalanceComputedByA":700000}
{"accountId":"10","newBalanceComputedByB":800000}
{"accountId":"10","bUpdateBlockedMs":263}
{"finalBalanceCents":800000,"correctBalanceCents":500000,"lostUpdateOccurred":true}
```

Real `pg_locks`/`pg_stat_activity` snapshot captured while B's `UPDATE` was
blocked (trimmed to the two rows that matter most - the full snapshot also
includes granted relation/pkey/unique-index locks each backend holds for
routine reasons):

```json
{
  "pid": 102,
  "locktype": "transactionid",
  "mode": "ShareLock",
  "granted": false,
  "relation": null,
  "state": "active",
  "waitEventType": "Lock",
  "waitEvent": "transactionid",
  "query": "UPDATE accounts SET balance_cents = $1 WHERE id = $2"
}
```

This is transaction B (pid 102), waiting (`granted: false`) to acquire a
`ShareLock` on transaction A's transaction ID - not on the `accounts` table.
Waiting for someone else's transaction ID to finish IS what a blocked row
lock looks like from `pg_locks`'s point of view.

**`pnpm scenario:select-for-update`**:

```json
{"accountId":"11","balanceSeenByA":1000000}
{"accountId":"11","balanceSeenByB":700000,"bSelectBlockedMs":261}
{"finalBalanceCents":500000,"correctBalanceCents":500000,"bothWithdrawalsCorrectlyReflected":true}
```

**`pnpm scenario:nowait-lock-timeout`**:

```json
{"errorCode":"55P03","errorMessage":"could not obtain lock on row in relation \"accounts\"","elapsedMs":2,"raisedImmediately":true}
{"errorCode":"55P03","errorMessage":"canceling statement due to lock timeout","elapsedMs":504,"lockTimeoutMs":500,"abortedAfterTimeout":true}
```

Both `NOWAIT` and `lock_timeout` raise the SAME SQLSTATE (`55P03`,
`lock_not_available`) - the difference is entirely in the message and in how
long Postgres actually waited before raising it (2ms vs 504ms).

**`pnpm scenario:lock-modes`**:

```json
{"forShareConcurrent":{"aElapsedMs":1,"bElapsedMs":1,"bothAcquiredWithoutBlocking":true,"writerBlockedMs":414,"writerWaitedForBothReaders":true}}
{"forUpdateBlocksForShare":{"forShareBlockedMs":261,"forShareBlockedOnForUpdate":true}}
{"keyShareVsNoKeyUpdate":{"keyShareAgainstNonKeyUpdateBlockedMs":2,"keyShareAgainstNonKeyUpdateBlocked":false,"keyShareAgainstKeyUpdateBlockedMs":255,"keyShareAgainstKeyUpdateBlocked":true}}
```

Both `FOR SHARE` holders acquired their lock in ~1ms (no blocking between
them); the writer's plain `UPDATE` blocked for 414ms - it only unblocked
after BOTH readers committed, not just the first. `FOR SHARE` itself blocked
261ms waiting on a concurrent `FOR UPDATE`. And the `FOR KEY SHARE` vs
`FOR NO KEY UPDATE` claim holds exactly as documented: a concurrent
`FOR KEY SHARE` acquired in 2ms against an open `UPDATE owner_name` (a
non-unique column - takes `FOR NO KEY UPDATE`, which does not conflict with
`FOR KEY SHARE`), but took 255ms against an open `UPDATE public_id` (a
`UNIQUE` column - takes full `FOR UPDATE`, which conflicts with everything).

`pnpm test` (12 tests across 4 files) and `pnpm typecheck` both pass cleanly
against this output. The full reset flow
(`docker compose down -v && docker compose up -d`, then `pnpm db:migrate`,
`pnpm seed`, `pnpm test`) was also verified from a clean slate.
