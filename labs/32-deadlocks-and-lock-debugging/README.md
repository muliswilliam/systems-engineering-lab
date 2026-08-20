# Lab 32 - Deadlocks and Lock Debugging

## Why this exists

Lab 10 taught row locks and `SELECT ... FOR UPDATE` as a one-directional
story: transaction B blocks behind transaction A's lock, and once A commits,
B proceeds. That story is incomplete. In production, two transactions can
each be waiting on a lock the OTHER one holds, at the same time - a cycle,
not a line. PostgreSQL cannot resolve that on its own by simply waiting
longer, because waiting longer never helps: neither side will ever release
what the other needs. This is a genuine, textbook deadlock, and it happens
constantly in real systems the moment two code paths touch the same two rows
in opposite orders - the "transfer money between two accounts" scenario is
the single most common way teams accidentally write one.

This lab does three things Lab 10 deliberately left for later: reproduces a
REAL PostgreSQL deadlock (not a simulated timeout), diagnoses it using
Postgres's own `pg_locks`/`pg_stat_activity` observability tools rather than
guessing, and fixes it with the one mechanism that actually prevents a
deadlock from forming - consistent lock ordering - while also showing why
"just retry" is a different, weaker guarantee that only recovers from the
problem after paying its cost.

## Learning objectives

After this lab you should be able to:

- explain precisely what a wait-for cycle is and why it cannot be resolved
  by waiting, only by aborting one side;
- reproduce a REAL PostgreSQL deadlock deterministically (every run, not
  occasionally) using explicit in-process synchronization instead of sleeps;
- read and interpret Postgres's own captured deadlock error - SQLSTATE
  `40P01`, its `detail` describing the actual process wait chain, and its
  `hint` - as the primary source of truth, not application logs;
- use `pg_locks` joined with `pg_stat_activity` to see the wait-for cycle
  directly, and understand why the standard "who's blocking whom" query
  already IS the deadlock-cycle diagnostic once you catch it mid-wait;
- explain why consistent lock ordering PREVENTS a deadlock from ever forming,
  while retry-on-deadlock only RECOVERS after one has already happened - and
  why that is a materially different guarantee, not two names for the same
  fix;
- explain why this lab's retry loop is a different mechanism from Lab 09's
  Serializable-retry loop, even though the code shape looks similar.

## Architecture

```text
accounts (id, public_id, owner_name, balance_cents, created_at)
```

A fresh, independent banking/ledger `accounts` table - the same minimal
shape Labs 05/07/08/10/18 each define independently for their own
concurrency concept, per this repository's independent-labs principle (none
of those tables, or this one, are shared or imported across labs).
"Transfer money between two accounts, locking both" is the textbook deadlock
scenario, and it composes Lab 10's own row-lock primitive two-at-a-time
instead of introducing a new mechanism. No `transfers`/audit table is added:
this lab's subject is `pg_locks`/`pg_stat_activity` state and Postgres's own
SQLSTATE `40P01`, not application bookkeeping - see `src/db/schema.ts`'s doc
comment.

```text
src/lib/sync.ts               <- createTwoPartyBarrier: explicit rendezvous, no sleeps
src/lib/support.ts            <- raw pg.Client helpers (Lab 06/10/13's established pattern)
src/lib/diagnostics.ts        <- waitUntilWaitingOnLock + the pg_locks/pg_stat_activity cycle query
src/lib/transfer.ts           <- planLeg (naive vs consistent ordering) + runLegAttempt/runLegWithRetry
src/lib/trial-pairs.ts        <- pairs up the seeded trial accounts for the many-trials scenario
src/seed/seed.ts              <- 2 named scenario accounts + N deterministic trial pairs
src/scenarios/reproduce-deadlock.ts        <- Points 1+2: the real deadlock, plus the diagnostic
src/scenarios/consistent-lock-ordering.ts  <- Point 3: THE fix
src/scenarios/retry-on-deadlock.ts         <- Point 3 (complementary): recovery, not prevention
src/scenarios/many-trials.ts               <- Point 3: N concurrent trials, 0 vs N deadlocks
```

**The synchronization mechanism** (`src/lib/sync.ts`'s
`createTwoPartyBarrier`): both transaction legs run in the SAME Node
process against two independent `pg.Client` connections. Each leg locks its
FIRST row, then calls `arriveAndWaitForPeer()` - a real `Promise`-based
rendezvous, not a `setTimeout`. Both legs are therefore guaranteed to have
already taken their first lock before either one requests its second, every
single run. This is what makes the deadlock in `reproduce-deadlock.ts`
100% reproducible rather than a race that sometimes wins.

**A real bug this lab's own validation caught**: the barrier above only
terminates correctly when both legs' FIRST lock is on a DIFFERENT row (true
for naive ordering). An early version of `consistent-lock-ordering.ts` reused
the same barrier - but under consistent ordering, both legs' first lock is
the SAME row by design, so one side's first `SELECT ... FOR UPDATE` blocks
on a REAL Postgres lock before it can ever reach the rendezvous point, while
the other side sits waiting on the barrier for a peer that can never arrive
until the first side commits - an application-level deadlock, not a Postgres
one. The fix (see `consistent-lock-ordering.ts`'s doc comment) is not to use
the barrier there at all: ordinary Postgres lock contention is the entire
mechanism the fix relies on, and forcing artificial simultaneity is not just
unnecessary, it is actively wrong once both legs agree on lock order.
`many-trials.ts` only builds a barrier for the naive strategy for the same
reason.

## Setup

```bash
pnpm install
cp labs/32-deadlocks-and-lock-debugging/.env.example labs/32-deadlocks-and-lock-debugging/.env
cd labs/32-deadlocks-and-lock-debugging
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - the migration is already checked in
pnpm db:migrate
pnpm seed          # default: 2 named scenario accounts + 150 trial pairs (302 accounts)
```

**Port collision note:** this lab's default `POSTGRES_PORT` is `5432` -
Postgres's own standard port - per this repository's `54NN` port convention
(lab `32` -> `5432`; see `ROADMAP.md`'s header). If you already have a local
Postgres running on your machine outside Docker (very common), `docker
compose up -d` will fail to bind that port. Override `POSTGRES_PORT` (and
update `DATABASE_URL`'s port to match) in your `.env` before starting - for
example `POSTGRES_PORT=5532` and `DATABASE_URL=postgres://lab32:lab32@localhost:5532/lab32`.
This lab's own validation run needed exactly this override, since the
validation machine had a local Postgres already listening on 5432.

Open PGweb at http://localhost:8432 (auto-connects via
`PGWEB_DATABASE_URL`). You should see 302 rows in `accounts`: 2 named
"Scenario Account - Deadlock A/B" rows plus 300 deterministically generated
trial-pair accounts.

`docker-compose.yml` sets `deadlock_timeout=300ms` (real Postgres default is
1s, lowered here purely for demo/test speed, the same "instance-wide, scoped
to this lab's own dedicated container" tuning Lab 31 documents for its own
`autovacuum_naptime`), `log_lock_waits=on`, and `max_connections=300` (the
many-trials scenario opens two real connections per concurrent trial pair).

## Scenario

Two transfer requests arrive for the same two accounts at almost the same
moment, moving money in opposite directions: "transfer $250.00 from A to B"
and "transfer $400.00 from B to A." Both are implemented the way a transfer
function reads most naturally - lock the account you're debiting first, then
the one you're crediting. What happens when both requests are in flight at
once?

## Prediction

Before running anything, predict:

1. Both transactions lock their own "from" account first, then request the
   other account. Can either one ever get its second lock? What does
   Postgres do about it, and after how long?
2. If you query `pg_locks` joined with `pg_stat_activity` at exactly the
   right moment, what would you expect to see for the two backend PIDs
   involved?
3. Now both transactions are changed so they ALWAYS lock the lower account
   id first, regardless of which way the money moves. Does the deadlock
   still happen? Does either transaction still have to wait?
4. If, instead of changing the lock order, the aborted transaction just
   retries itself after a `40P01`, does that also "fix" the problem? Is it
   the same fix?

## Exercise

```bash
pnpm scenario:deadlock   # Points 1 and 2: the real deadlock, plus the diagnostic
pnpm scenario:ordered    # Point 3: THE fix - consistent lock ordering
pnpm scenario:retry      # Point 3 (complementary): recovery via retry, not prevention
pnpm scenario:trials     # Point 3: 100 concurrent trials, naive vs ordered, side by side
pnpm test                # the same invariants, as automated, deterministic assertions
```

Every scenario resets the two named scenario accounts (or, for
`scenario:trials`, its own slice of trial-pair accounts) to a known baseline
balance before running, so they - and the tests that call them - are safe to
run repeatedly without re-seeding.

## Observe

- **PGweb** (http://localhost:8432): browse `accounts` before/after each
  scenario and watch `balance_cents` change - `scenario:deadlock` leaves
  exactly one transfer applied (the winner's), `scenario:ordered` and
  `scenario:retry` leave BOTH transfers applied.
- **`docker compose logs postgres`**: with `log_lock_waits=on`, Postgres
  itself logs any backend that has waited past `deadlock_timeout` for a
  lock - watch this appear during `pnpm scenario:deadlock`.
- **The real captured error object**: every scenario logs the aborted leg's
  actual `sqlstate`/`message`/`detail`/`hint` fields, exactly as Postgres's
  wire protocol returned them - not a summary this lab wrote.
- **The diagnostic snapshot**: `scenario:deadlock` polls
  `pg_stat_activity.wait_event_type = 'Lock'` for both backend PIDs, then
  queries `pg_locks` joined with `pg_stat_activity` (adapted from
  `packages/db-utils/sql/show-blocked-queries.sql`) scoped to those two PIDs
  - printed as `diagnosticEdges` in the log output.
- **Structured logs**: every scenario logs real backend PIDs, SQLSTATEs,
  attempt counts, and durations through `@labs/logging` (Pino).

## Break it

Real captured output from this lab's own validation run
(`pnpm scenario:deadlock`, unmodified):

```text
starting both legs - each locks ITS OWN 'from' account first, opposite lock order
  planA: { workerLabel: "A", fromAccountId: 1, toAccountId: 2, amountCents: 25000, firstLockId: 1, secondLockId: 2 }
  planB: { workerLabel: "B", fromAccountId: 2, toAccountId: 1, amountCents: 40000, firstLockId: 2, secondLockId: 1 }

DIAGNOSTIC: pg_locks + pg_stat_activity snapshot captured WHILE both transactions
are genuinely blocked - this is the real wait-for cycle, taken before Postgres's
own detector resolves it
  diagnosticEdges: [
    { waitingPid: 155, waitingQuery: "SELECT id FROM accounts WHERE id = $1 FOR UPDATE",
      blockedByPid: 156, blockedByQuery: "SELECT id FROM accounts WHERE id = $1 FOR UPDATE" },
    { waitingPid: 156, waitingQuery: "SELECT id FROM accounts WHERE id = $1 FOR UPDATE",
      blockedByPid: 155, blockedByQuery: "SELECT id FROM accounts WHERE id = $1 FOR UPDATE" }
  ]
  cycleObserved: true

REAL, CAPTURED Postgres deadlock victim - this is Postgres's own error, not simulated
  workerLabel: "A"
  sqlstate: "40P01"
  message: "deadlock detected"
  detail: "Process 155 waits for ShareLock on transaction 756; blocked by process 156.
            Process 156 waits for ShareLock on transaction 757; blocked by process 155."
  hint: "See server log for query details."

transaction leg outcome
  workerLabel: "B"
  status: "committed"

REAL DEADLOCK REPRODUCED: exactly one leg was aborted with SQLSTATE 40P01, the other committed
  finalBalanceAccountA: 1040000   finalBalanceAccountB: 960000
```

Every one of five repeated runs during this lab's own validation reproduced
the deadlock identically (`deadlockReproduced: true`, `cycleObserved: true`
every time) - this is deterministic because of the explicit rendezvous, not
a race that happened to land right five times in a row.

**Why this happens:** transaction A locks account 1 (its "from" account),
transaction B locks account 2 (ITS "from" account) - no contention yet, both
succeed immediately. Then A requests account 2 (already held by B) and B
requests account 1 (already held by A). Neither can proceed, and neither
ever will: A is waiting for something only B can release, and B is waiting
for something only A can release. This is a genuine cycle in the wait-for
graph. Postgres's own background deadlock detector - not this script -
notices it after `deadlock_timeout` elapses and picks one transaction as the
victim, aborting it with a real `SQLSTATE 40P01` whose `detail` field
literally describes the cycle it found (`"Process 155 waits for ... blocked
by process 156. Process 156 waits for ... blocked by process 155."`). The
other transaction's blocked lock request is immediately granted once the
victim's locks are released by its abort, and it proceeds to commit
normally.

**The diagnostic query IS the cycle detector for this case.** No special
"find the cycle" query was written for this lab - the same general
`show-blocked-queries.sql` "who's blocking whom" query Lab 10 already uses
(see `packages/db-utils/sql/show-blocked-queries.sql`), when run while both
sides are genuinely waiting, returns exactly the two edges that together
form the cycle: A waiting on B, and B waiting on A. A longer cycle
(3+ transactions) would show up as more edges in the same query - you would
just need to follow `blocked_by_pid` transitively to trace the whole ring;
see `playground/notes.md` for an exercise extending this to three accounts.

## Fix it

### Consistent lock ordering (the real fix - prevention)

```bash
pnpm scenario:ordered
```

Real captured output:

```text
starting both legs - BOTH now lock the lower account id first, regardless of
transfer direction (no artificial synchronization needed)
  planA: { fromAccountId: 1, toAccountId: 2, firstLockId: 1, secondLockId: 2 }
  planB: { fromAccountId: 2, toAccountId: 1, firstLockId: 1, secondLockId: 2 }

both legs finished - one committed quickly, the other waited a real, measurable
duration for an ordinary row lock, not a deadlock
  outcomeA: { status: "committed", attempts: 1 }
  outcomeB: { status: "committed", attempts: 1 }
  legADurationMs: 3   legBDurationMs: 5

FIXED: both legs committed, zero deadlocks - the slower leg genuinely WAITED
(real lock block), it never got aborted
  finalBalanceAccountA: 1015000   expectedBalanceAccountA: 1015000
  finalBalanceAccountB: 985000    expectedBalanceAccountB: 985000
```

Both transfers applied - `finalBalanceAccountA`/`B` exactly match the
expected values for BOTH the $250.00 A->B transfer AND the $400.00 B->A
transfer having genuinely committed, not just one surviving as in the naive
case.

### N concurrent trials: the invariant, not an anecdote

```bash
pnpm scenario:trials --trials=100
```

Real captured output from this lab's own validation run (100 independent
account pairs per strategy, run fully concurrently):

```text
naive-lock-order summary
  trialCount: 100   deadlockCount: 100   bothCommittedCount: 0   anomalyCount: 0
  balanceConserved: true

consistent-lock-order summary
  trialCount: 100   deadlockCount: 0   bothCommittedCount: 100   anomalyCount: 0
  balanceConserved: true

COMPARISON: identical business scenario, only the lock acquisition order differs
  naiveDeadlockRate: "100/100"   orderedDeadlockRate: "0/100"
```

**100 out of 100** naive-ordered trials deadlocked; **0 out of 100**
consistent-ordered trials did, for the byte-for-byte identical business
scenario (same transfer amounts, same account pairs shape, same
concurrency). `pnpm test`'s own run of this same scenario (40 trials per
strategy, to keep the automated suite fast) reproduced the same **40/40 vs
0/40** result. Total balance across every involved account was conserved in
every case, in both strategies - a deadlock's aborted leg is a full
rollback, not a partial write.

### Retry-on-deadlock (a complementary mitigation - recovery, not prevention)

```bash
pnpm scenario:retry
```

Real captured output:

```text
deadlock victim - backing off and retrying
  workerLabel: "B"   attempt: 1   sqlstate: "40P01"   retrying: true

this leg committed on its first attempt
  workerLabel: "A"   status: "committed"   attempts: 1

this leg was a real deadlock victim on an earlier attempt, then succeeded on retry
  workerLabel: "B"   status: "committed"   attempts: 2

RECOVERED: both legs eventually committed after 1 real deadlock(s) - contrast
this cost against consistent-lock-ordering.ts's zero deadlocks for the
identical scenario
  finalBalanceAccountA: 1015000   finalBalanceAccountB: 985000
```

Both transfers eventually applied correctly - but only after paying for a
REAL deadlock (a full `deadlock_timeout` wait, an aborted transaction, a
discarded partial UPDATE, a backoff sleep, and a second attempt). This is
recovery, not prevention: the SAME naive lock order is still in use, so the
next pair of opposite-direction transfers on these two accounts will
deadlock again, every time, and pay this cost again. Consistent ordering
above pays it zero times, ever, for the identical workload.

**This is NOT the same retry mechanism as Lab 09's Serializable retry
loop.** Lab 09 retries because SERIALIZABLE's Serializable Snapshot
Isolation detected a dangerous read/write dependency that could violate a
cross-row invariant under concurrent access - a correctness concern that
exists even if every transaction only ever takes ONE lock on ONE row at a
time, purely because of what each transaction READ. This lab's deadlock has
nothing to do with isolation level (it happens under the default READ
COMMITTED, and would happen identically under REPEATABLE READ or
SERIALIZABLE too) and everything to do with TWO transactions each holding a
lock the other is waiting for, in a cycle - a pure lock-ORDERING problem.
The retry loop shape looks similar (catch a specific SQLSTATE, back off,
retry) because "catch-backoff-retry" is a generic recovery pattern for any
transient, abort-producing conflict - but the underlying failure being
recovered from is completely different, and only one of the two failure
classes (this lab's) has a true prevention available at all.

`pnpm test` output from this lab's own validation run:

```text
✓ tests/integration/many-trials.test.ts (2 tests)
✓ tests/integration/reproduce-deadlock.test.ts (3 tests)
✓ tests/integration/consistent-lock-ordering.test.ts (3 tests)
✓ tests/integration/retry-on-deadlock.test.ts (2 tests)

Test Files  4 passed (4)
     Tests  10 passed (10)
Duration  3.86s
```

Rerun twice in a row with identical results (zero flakes across repeated
full-suite runs).

## Why the fix works

- **A deadlock is a cycle in the wait-for graph, not a chain.** Ordinary
  blocking (Lab 10) is a chain: B waits for A, A is not waiting for anyone,
  so eventually A finishes and B proceeds. A deadlock closes the chain into
  a ring: A waits for B, B waits for A. No amount of waiting breaks a ring;
  only aborting one participant does.
- **Consistent lock ordering makes a ring topologically impossible.** If
  every transaction that could ever touch both of two rows agrees to always
  request the SAME one first, then whichever transaction gets there first
  is, by construction, never waiting on anything the second transaction
  holds - there is nothing for a cycle to close around. The second
  transaction may still wait (an ordinary chain, like Lab 10), but it can
  never be waited on in return.
- **Retrying does not change the lock-acquisition order**, so it does not
  change the probability that a future concurrent pair of opposite-direction
  transfers forms the exact same cycle again. It only shortens how long the
  cycle survives once formed, by re-running the aborted work from scratch.

See `docs/lock-reference.md` for a cross-lab quick-reference on deadlocks,
`pg_locks`, and the other locking labs.

## Tradeoffs

- **Consistent lock ordering requires knowing ALL the ways two rows might be
  locked together, everywhere in the codebase.** A single code path anywhere
  that decides to lock in "from, then to" order instead of "lower id, then
  higher id" order reintroduces the exact deadlock this lab fixes - this is
  a discipline that must be enforced (a lint rule, a code-review checklist,
  a single shared helper function like this lab's `planLeg`), not an
  automatic database guarantee like a `UNIQUE` constraint.
- **Ordering by a value like `id` only works when the rows being locked have
  a stable total order you can compute BEFORE taking any lock.** If the set
  of rows to lock is discovered dynamically (e.g., "lock every seat in
  whichever section has fewest available"), consistent ordering means
  sorting that discovered set before locking it, not skipping the discipline.
- **Retry-on-deadlock is strictly worse in throughput terms** than a
  workload with zero deadlocks, but it is far simpler to bolt onto EXISTING
  code that already has inconsistent lock ordering scattered across it, and
  it composes with consistent ordering as a defense-in-depth backstop rather
  than a replacement for it - see "Production notes" below.
- **Lowering `deadlock_timeout`** (this lab uses `300ms` instead of
  Postgres's default `1s`) makes Postgres check for cycles more often, which
  detects real deadlocks faster but adds a small, constant CPU cost to EVERY
  lock wait longer than the threshold, deadlocked or not - a real production
  tuning tradeoff, not just a demo convenience, though this lab's own use of
  it IS purely for demo/test speed.

## Production notes

1. **What guarantee does Postgres's deadlock detector give?** It guarantees
   a genuine cycle will always be detected and broken - the database will
   never simply hang forever waiting on a cycle. It picks a victim (by an
   internal heuristic, not something an application should rely on) and
   aborts exactly that one transaction with SQLSTATE `40P01`.
2. **What does it NOT guarantee?** It does not guarantee WHICH side is
   aborted, does not prevent the cycle from forming in the first place, and
   does not make the aborted transaction's work resumable automatically -
   the application must handle `40P01` explicitly (discard or retry) the
   same way it must handle any other transaction-aborting error.
3. **What failure mode remains?** An application that never checks for
   `40P01` specifically will surface it to whatever generic error handling
   exists for "the query failed" - which may silently drop a legitimate
   business operation (a transfer that should have succeeded) instead of
   retrying or explaining the failure to the caller.
4. **How does contention affect it?** More concurrent transactions touching
   overlapping sets of rows in inconsistent orders increases the deadlock
   rate roughly with the SQUARE of concurrent write volume on the hot rows
   (each additional concurrent writer can form a cycle with each existing
   one) - this is why consistent ordering matters more, not less, as traffic
   grows.
5. **What changes at larger scale?** A hot, heavily-transacted table with
   many code paths locking rows in different orders becomes a genuine
   production incident source - "random transfers failing with deadlock
   errors under load" is a real, common on-call page. At scale, a single
   shared helper function that enforces lock order (this lab's `planLeg`) is
   worth promoting to a real, tested, mandatory library function, not a
   convention teams are expected to remember.
6. **What metrics would be monitored?** `pg_stat_database.deadlocks`
   (cumulative deadlock count per database, reset only on stats reset) as a
   rate over time; a spike correlates almost always with either a new code
   path violating existing lock order, or an increase in concurrent traffic
   against previously-rare-to-collide rows.
7. **When should retry-on-deadlock be used instead of / in addition to
   consistent ordering?** As a backstop, always - even perfectly-ordered code
   can still deadlock against a THIRD row-locking path nobody remembered to
   audit. As the ONLY fix, only when consistent ordering is genuinely
   infeasible (e.g., truly dynamic, unbounded sets of rows where sorting
   before locking is impractical) - and even then, know that it is paying
   real, recurring cost for something prevention would have avoided for
   free.

## Interview questions

1. Why can a deadlock never be resolved just by waiting longer, unlike
   ordinary lock contention?
2. Given `pg_locks` and `pg_stat_activity`, how would you determine, from
   OUTSIDE the application, which two backends are deadlocked RIGHT NOW,
   before Postgres's detector has acted?
3. Why does consistent lock ordering prevent a deadlock, while retrying
   after `40P01` does not, even though both eventually get the correct
   business outcome?
4. Two transactions each lock a DIFFERENT single row and never request a
   second lock. Can they deadlock? Why or why not?
5. Why is this lab's retry loop a different mechanism from Lab 09's
   Serializable-retry loop, even though the code shape (catch, backoff,
   retry) looks nearly identical?
6. If a lock-ordering bug is fixed in 9 of 10 code paths that touch two
   rows, does the deadlock rate drop by roughly 90%? Why or why not?
7. Why does lowering `deadlock_timeout` trade detection speed for a cost
   that exists even on locks that are NOT part of any deadlock?

## Further experiments

See `playground/notes.md` for:

- extending `reproduce-deadlock.ts` to a genuine 3-transaction, 3-account
  cycle, and checking whether the diagnostic query still shows the whole
  ring in one pass;
- restoring Postgres's real default `deadlock_timeout=1s` and confirming the
  deadlock still resolves identically, just slower to detect;
- pushing `scenario:trials --trials=150`+ against a larger `--pairs=` reseed
  and confirming the `deadlockCount === trialCount` (naive) /
  `deadlockCount === 0` (ordered) invariants hold at that scale too;
- confirming a transaction can safely re-lock the SAME row twice without
  deadlocking against itself.
