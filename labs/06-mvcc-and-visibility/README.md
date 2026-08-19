# Lab 06 - MVCC and Visibility

## Why this exists

Lab 05 showed that a transaction is all-or-nothing. This lab explains *how*
Postgres can let many transactions read and write the same rows at once
without readers and writers constantly getting in each other's way: MVCC
(Multi-Version Concurrency Control). Every engineer eventually hits the
moment where their mental model of "a row" (one slot in a table, mutated in
place) turns out to be wrong for Postgres, and the practical consequences
(bloat, `xmin` wraparound, why an index needs `HOT` updates, why a long
transaction is dangerous) are all downstream of the same fact: an `UPDATE`
never overwrites a row, it creates a new tuple version next to the old one.
This lab makes that fact impossible to un-see.

## Learning objectives

After this lab you should be able to:

- explain what `xmin`, `xmax`, and `ctid` are and read their real values off
  a live table;
- explain, with evidence, that `UPDATE` in Postgres inserts a new tuple
  version and marks the old one dead - it does not mutate a row in place;
- explain why a plain `SELECT` never sees another transaction's uncommitted
  write (no dirty reads), even though Postgres's default isolation level is
  the "weakest" one on offer;
- explain why, under the default READ COMMITTED isolation level, a
  transaction's *next* statement can see a change that its *previous*
  statement inside the same still-open transaction did not - and why that
  is not a contradiction of "no dirty reads";
- explain why a plain read does not block a concurrent writer, and
  contrast that with `SELECT ... FOR UPDATE`, which does;
- use two independent database connections (raw `pg` sessions, not a shared
  pool) to drive a real, reproducible interleaving between two transactions.

## Architecture

```text
┌────────────────────┐        ┌────────────────────┐
│ session A (pg.Client)│      │ session B (pg.Client)│
│ BEGIN; SELECT ...    │      │ BEGIN; UPDATE ...    │
│ (held open)          │      │ COMMIT               │
└─────────┬────────────┘      └─────────┬────────────┘
          │                             │
          └───────────►  PostgreSQL  ◄──┘
                       (counters table)
                             ▲
                     pgweb (browser UI)
```

Domain: a single, deliberately minimal `counters` table (`label`, `value`,
plus the repo-wide `id`/`public_id` pair - see `src/db/schema.ts`). This lab
does **not** reuse the payroll/commerce domains from Labs 01-04: MVCC
visibility and tuple versioning are properties of one row's update history
across time and across sessions, and a rich relational domain (foreign
keys, joins) would only add noise around the thing actually being observed
- the `xmin`/`xmax`/`ctid` of one row, seen from two connections. A
`counters` table (think a page-view counter) is the smallest schema that
still lets every experiment be phrased naturally ("increment the counter").

This is also the first lab in the repo built around **two independent
database sessions** rather than one shared Drizzle pool - see
`src/db/session.ts`. Every scenario and every concurrency test in this lab
opens two (or more) raw `pg.Client` connections and drives them with
explicit, ordered `async`/`await` control flow, because a shared pool
cannot guarantee "this specific transaction is still open on this specific
connection while another script does something else."

## Setup

```bash
pnpm install
cp labs/06-mvcc-and-visibility/.env.example labs/06-mvcc-and-visibility/.env
cd labs/06-mvcc-and-visibility
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate
pnpm seed
```

Open PGweb at http://localhost:8406 and connect (it auto-connects via
`PGWEB_DATABASE_URL`). You should see a `counters` table with 5 rows
(`page-views`, `signups`, `orders-processed`, `api-errors`, `cache-hits`).

## Scenario

A `page-views` counter is read and written by many concurrent requests.
Two things need to be true for this to be safe and fast:

1. a reader must never see another request's half-finished write;
2. a reader looking at the counter must not force writers to queue up
   behind it.

Postgres gives you both, for free, through MVCC - but the exact boundary of
what "for free" means (per-statement snapshots, not per-transaction; reads
never block writes, but locking reads do) is exactly what trips people up,
and exactly what this lab makes concrete.

## Prediction

Before running anything, predict:

1. If transaction A reads a row, and transaction B updates and commits that
   same row while A's transaction is still open, does A's *next* read (same
   open transaction) see the old value or B's new value?
2. Does an `UPDATE` change a row's `ctid`? Does it change its `xmin`?
3. If session A opens a transaction and just does a plain `SELECT` on a row
   (no `FOR UPDATE`), and holds that transaction open for 3 seconds, can
   session B `UPDATE` and `COMMIT` that same row in the meantime?

## Exercise

1. Run the setup commands above.
2. Run `pnpm scenario:snapshot-isolation` and compare its output against
   your answer to prediction #1.
3. Run `pnpm scenario:xmin-xmax-ctid` and compare its output against your
   answer to prediction #2.
4. Run `pnpm scenario:readers-dont-block-writers` and compare its output
   (real elapsed milliseconds) against your answer to prediction #3.

## Observe

- **PGweb** (http://localhost:8406): browse `counters`; PGweb's SQL runner
  can execute `SELECT xmin, xmax, ctid, * FROM counters;` directly.
- **`docker compose logs postgres`**: every `BEGIN`/`UPDATE`/`COMMIT` this
  lab's scripts send, in order (`log_statement=all`).
- **Structured logs**: every scenario script logs real captured
  `xmin`/`xmax`/`ctid` values and, for the blocking demo, real elapsed
  milliseconds - not simulated numbers.
- **`pg_stat_activity`**: while `pnpm scenario:readers-dont-block-writers`
  is running, run `SELECT pid, state, wait_event_type, query FROM
  pg_stat_activity WHERE datname = 'lab06';` in another terminal (`psql
  "$DATABASE_URL"`) and watch phase 2's writer sit in `state = active`,
  `wait_event_type = Lock` while phase 1's writer never does.

### Real captured output (from this repository's own validation run)

`pnpm scenario:snapshot-isolation`:

```text
A's first read,  statement 1: value=0,   xmin=755, ctid=(0,18)
B updates (+100), NOT committed yet
A's second read, statement 2: value=0,   xmin=755, ctid=(0,18)   <- no dirty read
B commits
A's third read,  statement 3: value=100, xmin=756, ctid=(0,19)   <- new tuple, same open tx
```

`pnpm scenario:xmin-xmax-ctid`:

```text
inserted:               xmin=757, ctid=(0,20), value=1
updated:                xmin=758, xmax=0,      ctid=(0,21), value=2
ordinary SELECT by OLD ctid (fresh snapshot): 0 rows found
raw page, OLD line pointer (lp=20): lp_flags=1, t_xmin=757, t_xmax=758, t_ctid=(0,21)
raw page, NEW line pointer (lp=21): lp_flags=1, t_xmin=758, t_xmax=0,   t_ctid=(0,21)
```

`pnpm scenario:readers-dont-block-writers`:

```text
phase 1 (plain SELECT, open tx, held 3000ms): writer's UPDATE returned in   2ms
phase 2 (SELECT ... FOR UPDATE, held 3000ms): writer's UPDATE returned in 3002ms
```

## Break it

The naive assumption: "a concurrent reader must be able to see my
in-progress write, since it's already the value in the table - or,
conversely, if there's real isolation, an open transaction should keep
seeing the same thing all the way through, like a photograph taken once at
`BEGIN`."

Both halves of that assumption are checked, and each is wrong in its own
way:

```bash
pnpm scenario:snapshot-isolation
```

- **Half 1 is wrong the "safe" direction**: while session B's `UPDATE` is
  uncommitted, session A's second read still sees the pre-update value and
  the *exact same* `xmin`/`ctid` as its first read. Postgres never exposes
  an uncommitted write to another session - there is no such thing as
  `READ UNCOMMITTED` in Postgres; asking for it silently gives you `READ
  COMMITTED` instead.
- **Half 2 is wrong the "surprising" direction**: the instant B commits,
  A's very next statement - still inside A's still-open transaction - sees
  B's new value and a brand-new `xmin`/`ctid`. Under the default READ
  COMMITTED isolation level, each *statement* gets a fresh snapshot, not
  each *transaction*. A transaction-wide consistent snapshot is REPEATABLE
  READ behavior (Lab 08); the isolation-level semantics and when
  non-repeatable reads actually matter for your application are Lab 07's
  job. This lab only demonstrates the tuple-versioning mechanism
  (`xmin`/`ctid` changing to a new physical tuple) that makes both
  observations possible.

## Fix it

The "fix" here is a mental model, not a code change: **you read a
snapshot, not the live table.** Within one statement, Postgres hands you a
consistent view of the database as of that statement's snapshot. If you
need fresher data, you ask again - either with a new statement in the same
READ COMMITTED transaction (gets a new snapshot automatically, as shown
above), or by starting a new transaction entirely. There is no way to
"peek" at another transaction's in-flight, uncommitted state, by design.

If your application actually needs the *opposite* guarantee - one
consistent snapshot for an entire transaction, even across multiple
statements - that is what REPEATABLE READ (Lab 08) is for. Lab 06 is
scoped to showing you the tuple-versioning substrate; which isolation level
to reach for is Labs 07-09's job.

## Why the fix works

Every tuple carries `xmin` (the id of the transaction that created it) and
`xmax` (the id of the transaction that deleted/replaced it, or `0` if it is
still live). A snapshot is essentially "the set of transaction ids that
count as already-committed as of right now." Visibility of any given tuple
to any given snapshot is a pure function of that tuple's `xmin`/`xmax`
against the snapshot - no locks, no blocking, no coordination between
readers required. That is also exactly why a plain reader never blocks a
writer: the writer is free to create a new tuple version at any time,
because it doesn't touch the tuple version any existing reader's snapshot
is already looking at.

## Tradeoffs

- **Multiple tuple versions cost space.** Every `UPDATE` (and every
  aborted transaction's `INSERT`) leaves a dead tuple behind until VACUUM
  reclaims it. High-churn tables need aggressive autovacuum tuning or they
  bloat (Lab 31).
- **Read Committed's per-statement snapshot is convenient but can surprise
  you.** A multi-statement business transaction can see a different value
  for the same row between its own statements, purely because another
  transaction committed in between (Lab 07's non-repeatable read).
- **A held-open snapshot (even one from a `SELECT`) has a cost.** It pins
  Postgres's ability to reclaim tuples that were deleted after that
  snapshot was taken, for as long as that transaction is open under an
  isolation level that holds a transaction-wide snapshot (REPEATABLE READ /
  SERIALIZABLE). Under READ COMMITTED, an *idle* open transaction between
  statements does not pin a snapshot (see "Further experiments" - this lab
  measured that directly), but a transaction that is still actively running
  a long query, or is REPEATABLE READ/SERIALIZABLE, does.
- **`ctid` is not a stable row identifier.** It changes on every `UPDATE`
  and can be reused after VACUUM. Never store a `ctid` outside a single
  statement's lifetime.

## Production notes

1. **What guarantee does this technique provide?** Readers always see a
   internally consistent, committed snapshot of the database; writers are
   never blocked by ordinary (non-locking) readers.
2. **What does it not guarantee?** That a transaction's own view of the
   data stays constant across multiple statements (that's REPEATABLE READ,
   Lab 08) - or that concurrent updates to related rows can't produce a
   business-level anomaly (write skew, Lab 09).
3. **What breaks under process crash?** An uncommitted transaction's tuples
   are simply dead-on-arrival (never visible to anyone) once the backend
   disconnects without committing - nothing to clean up beyond ordinary
   VACUUM.
4. **What breaks under network partition?** Not applicable at this scale -
   single Postgres node, no replicas yet (Lab 24+).
5. **What changes at high contention?** MVCC itself doesn't degrade under
   read contention (that's the point), but write contention on the *same*
   row still serializes at commit time, and a high rate of updates on a hot
   row produces a high rate of dead tuples that autovacuum must keep up
   with.
6. **What changes with multiple regions?** Not applicable yet - single
   node.
7. **What metrics would you monitor?** `pg_stat_user_tables.n_dead_tup`,
   autovacuum run frequency/duration, transaction id (`xid`) age
   (wraparound risk), long-running-transaction age from `pg_stat_activity`.
8. **What simpler alternative could be used?** None - MVCC is Postgres's
   concurrency model, not an optional technique you opt into.
9. **When should you avoid this technique?** N/A as a "technique" - but the
   corollary is real: avoid holding transactions open longer than
   necessary (idle-in-transaction sessions, forgotten `BEGIN`s from a
   connection pool) because they hold back the vacuum horizon and can bloat
   unrelated tables.

## Interview questions

1. What is the difference between `xmin`/`xmax` and a "transaction ID" you
   might see in `pg_stat_activity.backend_xmin`?
2. Why doesn't a plain `SELECT` need to acquire a row lock the way an
   `UPDATE` does?
3. If READ COMMITTED gives a fresh snapshot per statement, why does
   Postgres still guarantee no dirty reads?
4. Why does `ctid` change on every `UPDATE`, and why is it unsafe to use as
   a long-lived row identifier?
5. What does it mean for a tuple to be "dead but not yet vacuumed," and
   what has to be true before Postgres is allowed to reclaim it?
6. Why might an idle transaction sitting open in a connection pool cause
   table bloat on tables it never even queried?

## Further experiments

- Change `READER_HOLD_MS` in `src/scenarios/readers-dont-block-writers.ts`
  and rerun - the "not blocked" timing should stay roughly constant
  regardless of how long the plain-SELECT reader holds its transaction
  open, while the `FOR UPDATE` case should scale with it.
- This lab's `xmin-xmax-ctid.ts` originally tried to find the dead tuple
  with a plain `SELECT ... WHERE ctid = $1`. That failed once the deleting
  transaction committed - an ordinary `SELECT` still enforces MVCC
  visibility even when filtering by `ctid`, so a "dead to my snapshot"
  tuple is invisible no matter how you address it. The fix (used in the
  checked-in version) is `pageinspect`'s `heap_page_items`, which reads the
  raw page bytes and bypasses visibility entirely. Try reverting to the
  plain-`SELECT` version yourself and confirm you get 0 rows.
- Try holding a session open under `BEGIN ISOLATION LEVEL REPEATABLE READ`
  vs plain `BEGIN` (READ COMMITTED) while idle between statements, and
  compare `pg_stat_activity.backend_xmin` for that session in each case -
  during this lab's own development, a REPEATABLE READ session's
  `backend_xmin` stayed pinned to its first snapshot even while idle, while
  a READ COMMITTED session's `backend_xmin` went back to `NULL` between
  statements. That is the mechanism behind "Serializable/Repeatable Read
  transactions left open cause more bloat than Read Committed ones."
- Run `pnpm seed --size=medium` and rerun the scenario scripts - they
  target specific labels (`page-views`, `mvcc-demo-counter`) so behavior is
  unaffected, but PGweb will show more rows to browse.
