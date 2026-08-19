# Lab 31 - VACUUM, Autovacuum, and Bloat

## Why this exists

Lab 06 proved that PostgreSQL's MVCC model leaves the OLD tuple version on
disk every time a row is `UPDATE`d or `DELETE`d - a real, physical dead
tuple, visible via `pageinspect`. Lab 30's "Break it" section went one step
further and explained, without building a full demo, that a single
long-running transaction prevents `VACUUM` from cleaning up dead tuples
system-wide for its whole duration. This lab is the direct, deeper follow-up
both of those labs deferred: what happens when dead tuples accumulate faster
than anything reclaims them, for real, on a real table, with autovacuum
genuinely turned off - and what the two different forms of the fix actually
cost.

The mechanism is simple to state and easy to get wrong in production: every
`UPDATE`/`DELETE` leaves a dead tuple behind until `VACUUM` (manual or
automatic) reclaims it. If dead tuples pile up faster than they're cleaned
up - a paused autovacuum, an over-throttled configuration, a very hot table,
a long-running transaction holding back cleanup - the table and its indexes
physically grow larger than the live data requires. Every sequential scan,
every index scan, and the buffer cache's hit ratio all get worse, for a
reason that never shows up in `SELECT COUNT(*)`.

## Learning objectives

After this lab you should be able to:

- explain precisely what a dead tuple is and why `n_dead_tup` can climb
  without bound if nothing vacuums a table;
- reproduce real, measured table bloat - physical size and dead-tuple count
  both growing beyond what the live row count requires - on a real
  PostgreSQL instance;
- measure the concrete query-performance cost of bloat via
  `EXPLAIN (ANALYZE, BUFFERS)`, in real buffers touched and real
  milliseconds, not just "it feels slower";
- explain precisely why plain `VACUUM` does not shrink a table's file on
  disk, while `VACUUM FULL` does - and what `VACUUM FULL` costs in exchange;
- demonstrate, with a real measured lock conflict, why `VACUUM FULL`'s
  `ACCESS EXCLUSIVE` lock is a genuinely different risk profile from plain
  `VACUUM`'s `ShareUpdateExclusiveLock`;
- confirm autovacuum actually ran via `pg_stat_user_tables`, not just assume
  it did, and describe the main tuning knobs and why over-throttling
  autovacuum is a real, recurring production incident.

## Architecture

```text
page_views (id, public_id, slug, view_count, updated_at)
```

A fresh, standalone `page_views` table - not one of SPEC.md section 8.2's
five named domains. This lab is about the VACUUM/bloat MECHANISM, not a rich
relational model, the same "small standalone table, the lesson is the
mechanism" rationale as Lab 06's `counters`/Lab 11's `documents`/Lab 23's
`widgets`/Lab 30's `orders`. `view_count` is this lab's "hot column": a
page-view counter incremented on every request to a popular URL - a
completely realistic production pattern (analytics counters, account
balances, job-progress percentages all share the same shape: a small,
frequently-`UPDATE`d row). Deliberately NOT Lab 06's `counters` table
despite the superficial similarity: Lab 06 uses one hand-picked row to
inspect raw `xmin`/`xmax`/`ctid` tuple mechanics via `pageinspect`; this lab
needs many thousands of rows updated many times over so real physical table
growth and real `pg_stat_user_tables` dead-tuple counts become measurable at
table scale, not single-tuple scale. Per the independent-labs principle,
this schema shares no code or state with Lab 06.

```text
src/seed/seed.ts                        <- deterministic seed, --size=small|medium|large or --rows=N
src/scenarios/pg-stats.ts               <- shared pg_relation_size/pg_stat_user_tables/EXPLAIN helpers
src/scenarios/write-prober.ts           <- shared "ordinary concurrent write" latency measurement
src/scenarios/create-bloat.ts           <- shared bloat-reproduction mechanism (2 consumers)
src/scenarios/reproduce-bloat.ts        <- Point 1 + 2: real bloat, then real query-performance cost
src/scenarios/vacuum-vs-full.ts         <- Point 3: plain VACUUM vs VACUUM FULL, size AND blocking
src/scenarios/autovacuum-recovery.ts    <- Point 4: autovacuum actually running, confirmed
```

A real PostgreSQL observability gotcha surfaced and had to be worked around
while building this lab (documented in detail in `create-bloat.ts` and
`seed.ts`): a single backend only flushes its own pending
`pg_stat_user_tables` report to shared memory at most once per ~1 second
(and `TRUNCATE`'s stats reset goes through the same pipeline) - hammering
many UPDATEs through one long-lived, reused connection left this lab's own
`n_live_tup`/`n_dead_tup` readings stale and, during development, briefly
showing `n_live_tup` at DOUBLE the real row count. The fix used throughout
this lab's scenarios: run each mutating statement on its own short-lived
connection and explicitly close it, which forces PostgreSQL to flush that
backend's final report immediately; seeding also calls
`pg_stat_reset_single_table_counters` right after `TRUNCATE` for a
synchronous, guaranteed-clean baseline. This is a real caveat worth knowing
if you ever query `pg_stat_user_tables` from the same long-lived connection
that just wrote to the table.

## Setup

```bash
pnpm install
cp labs/31-vacuum-autovacuum-and-bloat/.env.example labs/31-vacuum-autovacuum-and-bloat/.env
cd labs/31-vacuum-autovacuum-and-bloat
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - the migration is already checked in
pnpm db:migrate
pnpm seed          # default: --size=small, 5,000 rows
```

Open PGweb at http://localhost:8431 (auto-connects via
`PGWEB_DATABASE_URL`). You should see 5,000 rows in `page_views`, all with
`view_count = 0`.

**This lab's `pnpm seed` sizes:**

| `--size=` | rows | intended use |
|---|---|---|
| `small` (default) | 5,000 | `pnpm test`, quick interactive runs |
| `medium` | 50,000 | the real "Break it" bloat/query-performance numbers below |
| `large` | 150,000 | building bigger bloat for `scenario:vacuum`'s own default |

`--rows=N` overrides any preset. `docker-compose.yml` sets
`autovacuum_naptime=2s` (instance-wide, scoped to this lab's own dedicated
Postgres container only) and `log_autovacuum_min_duration=0` so autovacuum
runs are visible in `docker compose logs postgres` and complete within
seconds rather than up to a minute, purely to keep this lab's own demos on a
human timescale - it does not change what autovacuum DOES, only how often
the launcher checks.

## Scenario

`page_views.view_count` is a hot column - every page view increments it.
Someone temporarily disables autovacuum on this one table (a real, if
unwise, thing that happens during a migration, a bulk backfill, or a
misconfigured maintenance window) and thousands of view-count increments
happen while it's off. What does the table look like afterward, what does
that cost every query touching it, and what does it take to fix?

## Prediction

Before running anything, predict:

1. A 50,000-row table gets its every row `UPDATE`d 15 times over, with
   autovacuum disabled for that table. How much physically larger does the
   table get, and does `SELECT COUNT(*)` still report 50,000?
2. A plain `SELECT COUNT(*)` sequential scan is run against the bloated
   table and against a freshly-written table holding the identical 50,000
   live rows. Does the bloated one read more 8&nbsp;KB pages? Does it take
   measurably longer?
3. Plain `VACUUM` is run against the bloated table. Does `n_dead_tup` drop?
   Does `pg_relation_size` shrink? Now `VACUUM FULL` is run. Which of those
   two things changes this time - and what does a concurrent ordinary write
   experience differently during each of the two operations?
4. Autovacuum is re-enabled and tuned to react quickly. Without anyone
   running `VACUUM` by hand, does the table clean itself up - and how would
   you actually confirm that from outside the database?

## Exercise

```bash
pnpm seed --size=medium
pnpm scenario:bloat        # Points 1 and 2: real bloat, then real query-performance cost
pnpm scenario:vacuum       # Point 3: plain VACUUM vs VACUUM FULL - size AND blocking, both real
pnpm scenario:autovacuum   # Point 4: autovacuum actually running, confirmed via pg_stat_user_tables
pnpm test                  # the same invariants, as automated, deterministic assertions
```

`scenario:vacuum` and `scenario:autovacuum` each reseed and rebuild their
own bloat internally, so they can be run in any order or repeated without
re-running `scenario:bloat` first.

## Observe

- **PGweb** (http://localhost:8431): browse `page_views` mid-`scenario:bloat`
  run and watch `view_count` climb - the table looks completely ordinary
  from a row-browsing view; bloat is invisible unless you look at physical
  size or `pg_stat_user_tables`, which is exactly why it's easy to miss in
  production.
- **`docker compose logs postgres`**: with `log_autovacuum_min_duration=0`,
  every autovacuum run (worker start, tuples removed, duration) is logged -
  watch it appear in real time during `pnpm scenario:autovacuum`, and watch
  it stay silent for `page_views` during `pnpm scenario:bloat` (autovacuum
  disabled for that table only).
- **`SELECT relname, n_live_tup, n_dead_tup, last_vacuum, last_autovacuum,
  vacuum_count, autovacuum_count FROM pg_stat_user_tables WHERE relname =
  'page_views';`** - run this from a second `psql`/PGweb session at any
  point to see the exact same numbers this lab's scripts print.
- **`SELECT pg_relation_size('page_views'), pg_total_relation_size('page_views');`**
  - the heap-only vs. heap-plus-indexes-plus-TOAST size; watch the first
    stay flat across a plain `VACUUM` and drop sharply after `VACUUM FULL`.
- **Structured logs**: every scenario logs real byte counts, tuple counts,
  durations, and latency percentiles through `@labs/logging` (Pino) - not
  just a final pass/fail.

## Break it

Real captured output from this lab's own validation run
(`pnpm seed --size=medium`, 50,000 rows, 15 full-table `UPDATE` passes,
autovacuum disabled for `page_views` only):

```bash
pnpm scenario:bloat
```

```text
--- bloat reproduction: 15 full-table UPDATE passes over 50000 rows, autovacuum disabled ---
baseline: freshly seeded, autovacuum disabled for page_views
  relationSizeBytes: 5341184   deadTuples: 0

... 15 "update pass committed" log lines ...

REAL, MEASURED BLOAT: the table is now physically larger than its live row count
requires - every dead tuple from every UPDATE pass is still on disk
  durationMs: 3307
  before: { relationSize: "5.09MB", liveTuples: 50000, deadTuples: 0 }
  after:  { relationSize: "80.86MB", liveTuples: 50000, deadTuples: 748276 }
  sizeGrowthRatio: 15.87   totalTupleVersionsCreated: 750000

created page_views_fresh: same LIVE row count, zero bloat, freshly written pages
  bloatedLiveRows: 50000   freshLiveRows: 50000
  bloatedRelationSize: "80.86MB"   freshRelationSize: "5.50MB"

WHY BLOAT MATTERS: a plain sequential scan for the SAME live row count reads
measurably more pages, and takes measurably longer, on the bloated table
  bloated: { executionTimeMs: 5.679, buffers: 10350, rowsReturned: 1 }
  fresh:   { executionTimeMs: 5.284, buffers: 704,   rowsReturned: 1 }
  bufferRatio: 14.7   timeRatio: 1.07
```

The table grew from **5.09MB to 80.86MB - 15.87x its original size** - while
`SELECT COUNT(*)` still correctly reports **50,000 live rows the entire
time**. 15 full-table UPDATE passes created 750,000 total tuple versions
(`totalTupleVersionsCreated`); with autovacuum disabled for this table, none
of the 700,000+ old versions were ever reclaimed, so Postgres had to extend
the heap file with new pages to hold every one of them.

**Why this happens:** every `UPDATE` leaves the OLD tuple version behind as
a dead, no-longer-visible-to-anyone row version (Lab 06's MVCC mechanics,
now compounding at table scale). Normally autovacuum notices `n_dead_tup`
climbing past a threshold and reclaims that space in the background. With
`ALTER TABLE page_views SET (autovacuum_enabled = false)` set - a real,
per-table setting someone might set during a bulk backfill and forget to
unset - nothing ever does.

**Why it matters, concretely:** cloning the table's CURRENT live rows into a
freshly-written `page_views_fresh` (same 50,000 live rows, zero dead-tuple
history) and running the identical `EXPLAIN (ANALYZE, BUFFERS) SELECT
COUNT(*)` against both shows the bloated table touching **10,350 buffers**
against the fresh table's **704** - a real **14.7x more pages read** for the
exact same logical result. The execution-time difference in this lab's small
containerized Postgres (both tables are fully cached in memory, so this is
CPU/page-visitation cost, not disk I/O) is a much smaller, noisier ~1.07x -
on a real production instance where the extra 9,600+ buffers are NOT already
cached, the real-world time cost would be dramatically larger, since every
one of those extra buffers is a potential disk read instead of a memory hit.

## Fix it

### Plain VACUUM vs VACUUM FULL - both real, both measured

```bash
pnpm scenario:vacuum
```

Real captured output (this script builds its own bloat first: 80,000 rows,
20 full-table UPDATE passes, autovacuum disabled):

```text
bloat created - now demonstrating the fix
  relationSize: "169.75MB"   liveTuples: 80000   deadTuples: 1596808

starting concurrent write probes, then issuing plain VACUUM ...
PLAIN VACUUM: dead tuples reclaimed (marked reusable), but the file did NOT
shrink - and ordinary concurrent writes were barely affected
  plainVacuumDurationMs: 143.37
  deadTuplesBefore: 1596808   deadTuplesAfter: 15
  relationSizeBefore: "169.75MB"   relationSizeAfter: "169.75MB"
  concurrentWriteLatencyDuringPlainVacuum:
    { count: 91, minMs: 7.59, p50Ms: 16.97, p99Ms: 24.81, maxMs: 24.81 }

starting concurrent write probes, then issuing VACUUM FULL ...
VACUUM FULL: the file genuinely shrank - but at the cost of an ACCESS
EXCLUSIVE lock that blocked ordinary writes for close to its entire duration
  vacuumFullDurationMs: 89.77
  relationSizeBeforeVacuumFull: "169.75MB"   relationSizeAfterVacuumFull: "8.16MB"
  shrinkRatio: 20.79
  concurrentWriteLatencyDuringVacuumFull:
    { count: 43, minMs: 12.07, p50Ms: 19.51, p99Ms: 101.7, maxMs: 101.7 }

THE TRADEOFF: plain VACUUM's worst-case concurrent-write latency stayed close
to baseline; VACUUM FULL's worst case tracked almost exactly its own full duration
  plainVacuumDurationMs: 143.37   plainVacuumWorstBlockedMs: 24.81
  vacuumFullDurationMs: 89.77     vacuumFullWorstBlockedMs: 101.7
  vacuumFullBlockRatio: 1.133
```

**Plain `VACUUM`:** `n_dead_tup` dropped from **1,596,808 to 15** (essentially
zero) - but `pg_relation_size` stayed at **169.75MB, completely unchanged**.
15 concurrent ordinary writes (via 15 parallel probe connections hammering
the same row, since a single sequential prober can't reliably catch a
lock window this short) saw a worst case of **24.81ms**, close to their own
normal latency - nowhere near the VACUUM's own 143ms duration.

**`VACUUM FULL`:** the file genuinely shrank, from **169.75MB down to
8.16MB - a real 20.79x reduction**, close to what an equivalent freshly-built
80,000-row table would take. But the SAME concurrent-write probes this time
saw a worst case of **101.7ms against an 89.77ms VACUUM FULL duration -
`vacuumFullBlockRatio: 1.133`** - a write that happened to be queued when the
lock was grabbed waited for essentially the entire operation, not a fraction
of it.

`pnpm test` proves the underlying MECHANISM deterministically (not by racing
wall-clock timing): a transaction holding nothing more than a `SELECT`'s
`AccessShareLock` genuinely blocks a concurrent `VACUUM FULL` (a real
SQLSTATE `55P03` lock-timeout after ~150ms), while the identical held lock
does **not** block a concurrent plain `VACUUM` at all.

### Autovacuum, working as intended

```bash
pnpm scenario:autovacuum
```

Real captured output (5,000 rows, `autovacuum_vacuum_scale_factor = 0`,
`autovacuum_vacuum_threshold = 50`, `autovacuum_enabled = true`):

```text
baseline before any churn - autovacuum has not needed to run yet
  deadTuples: 0   autovacuumCount: 0   lastAutovacuum: null

performing one full-table UPDATE pass to create dead tuples far past the
50-row threshold ...
dead tuples now well past this table's autovacuum_vacuum_threshold - autovacuum
should pick this up on its next pass
  deadTuples: 5000   threshold: 50

AUTOVACUUM RAN, CONFIRMED VIA pg_stat_user_tables: autovacuum_count advanced
and dead tuples dropped, with zero operator intervention
  elapsedMs: 2023
  autovacuumCount: 1   lastAutovacuum: "2026-08-19T12:25:52.992Z"
  deadTuplesAfterAutovacuum: 0   relationSizeAfterAutovacuum: "1.02MB"
```

With no `VACUUM` command ever run by hand, `autovacuum_count` advanced from
**0 to 1** and `n_dead_tup` dropped from **5,000 to 0** within **2.02
seconds** - bounded by `docker-compose.yml`'s `autovacuum_naptime=2s`, not by
anything this script did.

`pnpm test` output from this lab's own validation run:

```text
✓ tests/integration/bloat-and-query-performance.test.ts (2 tests)
✓ tests/integration/vacuum-full-lock-conflict.test.ts (2 tests)
✓ tests/integration/autovacuum-recovery.test.ts (1 test)
✓ tests/integration/vacuum-reclaims-dead-tuples.test.ts (2 tests)

Test Files  4 passed (4)
     Tests  7 passed (7)
```

## Why the fix works

- **Plain `VACUUM` marks dead tuples' space REUSABLE, it does not return it
  to the operating system.** It scans the table, identifies tuples no
  transaction can still see, and records their space in a free-space map for
  FUTURE `INSERT`/`UPDATE`s to reuse - the file's high-water mark on disk
  doesn't move, so `pg_relation_size` stays the same.
- **`VACUUM FULL` rewrites the entire table into a brand-new file containing
  only live tuples**, then atomically swaps it in and drops the old file -
  this is what actually shrinks `pg_relation_size`.
- **The size fix and the locking cost are the same mechanism, not two
  separate tradeoffs.** `VACUUM FULL` needs the OLD file and the NEW file to
  never be visible half-written to any other transaction, which requires an
  `ACCESS EXCLUSIVE` lock - the strongest lock Postgres has, conflicting with
  every other lock mode including a plain `SELECT` - for the entire rewrite.
  Plain `VACUUM` only needs a `ShareUpdateExclusiveLock` (conflicts only with
  another VACUUM), because it never moves live tuples anywhere a concurrent
  reader could be confused by.
- **Autovacuum is the SAME plain `VACUUM` mechanism, launched automatically**
  once a table's dead-tuple count crosses
  `autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor * n_live_tup`
  - it gives you plain `VACUUM`'s guarantees (dead tuples reclaimed, minimal
  locking) without anyone having to run a command by hand, as long as it's
  actually enabled and its thresholds are tuned to react before dead tuples
  pile up too far.

## Tradeoffs

- **Plain `VACUUM` never shrinks a table that has already bloated.** If a
  table's file has already grown to hold a large amount of historical dead
  tuple churn, ONLY `VACUUM FULL` (or an equivalent rewrite, like
  `pg_repack`, which does the same rewrite without the exclusive lock for
  most of its duration) gets that disk space back. Plain `VACUUM` running
  forever afterward will not shrink it further - it only prevents FURTHER
  growth from FUTURE churn.
- **`VACUUM FULL`'s `ACCESS EXCLUSIVE` lock is a real production risk, not a
  theoretical one.** This lab's own measurement showed a concurrent ordinary
  write blocked for a duration matching almost the ENTIRE VACUUM FULL
  operation (`vacuumFullBlockRatio: 1.133`). On a large production table,
  `VACUUM FULL` can run for minutes to hours - during which every read AND
  write to that table queues up. Never run `VACUUM FULL` against a table with
  live traffic without a planned maintenance window (or use `pg_repack`,
  which trades a longer total operation for a much shorter final lock).
- **Autovacuum's per-table thresholds are a real tuning surface, not a "set
  once" default.** `autovacuum_vacuum_scale_factor = 0.2` (the instance
  default) means a 10-million-row table needs 2 million dead tuples before
  autovacuum even considers it - fine for a rarely-updated table, dangerously
  late for a hot one. This lab's own demo deliberately overrides both
  `autovacuum_vacuum_scale_factor` (to `0`) and `autovacuum_vacuum_threshold`
  (to `50`) as a PER-TABLE override specifically to make the demo fast, not
  as a universal recommendation - see "Production notes" below for real
  guidance.
- **This lab's `docker-compose.yml` sets `autovacuum_naptime=2s`
  instance-wide** (the launcher's wake-up interval, default 60s) purely to
  keep the demos on a human timescale. This does not change what a vacuum
  DOES once triggered, only how promptly the launcher notices a table
  qualifies - do not treat 2s as a production-appropriate value; it exists
  here purely for lab ergonomics.

## Production notes

1. **What guarantee does `VACUUM` (plain or automatic) give?** Every dead
   tuple no transaction can still see gets marked reusable, keeping a
   table's file from growing without bound under steady UPDATE/DELETE
   churn, and its own lock (`ShareUpdateExclusiveLock`) never blocks
   ordinary reads or writes.
2. **What does it NOT guarantee?** It does not shrink an already-bloated
   file - only `VACUUM FULL`/`pg_repack` does that, at the cost of a much
   stronger lock (or, for `pg_repack`, a longer total operation with a much
   shorter final lock). Plain `VACUUM` also does not run instantly - a very
   large table can take a long time to scan even when it finds little to
   reclaim.
3. **What failure mode remains?** Transaction ID wraparound: PostgreSQL
   needs `VACUUM` (specifically the freeze mechanism inside it) to run
   before a table's oldest unfrozen transaction ID gets more than ~2 billion
   IDs old, or the database has to force emergency, uninterruptible
   vacuuming to avoid data loss. An autovacuum disabled for too long on a
   busy table is a genuine, historically real production incident class,
   not a hypothetical - `autovacuum_freeze_max_age` exists specifically to
   force this before it becomes catastrophic.
4. **How does contention affect it?** A long-running transaction anywhere in
   the database holds back what `VACUUM` (even a healthy, enabled one) can
   reclaim, because it must preserve any tuple version that transaction's
   snapshot could still see - this is exactly the mechanism Lab 30's "Break
   it" section describes for its own giant UPDATE.
5. **What changes at larger scale?** `VACUUM`'s own duration scales with
   table size; on a very large table, even a "healthy" autovacuum run can
   take hours, during which its `ShareUpdateExclusiveLock` blocks other
   maintenance operations (like a manual `VACUUM FULL` or `CREATE INDEX`
   without `CONCURRENTLY`) though never ordinary traffic. `VACUUM FULL` at
   that scale is often infeasible during business hours at all - `pg_repack`
   or partitioning-and-dropping-old-partitions (see Lab 35) become the
   practical alternatives.
6. **What metrics would be monitored?** `pg_stat_user_tables.n_dead_tup`
   (and its ratio to `n_live_tup`) per table, `last_autovacuum`/
   `autovacuum_count` advancing on a reasonable cadence for hot tables,
   `age(relfrozenxid)` against `autovacuum_freeze_max_age` for wraparound
   risk, and `pg_stat_activity` for any single transaction open long enough
   to be holding back cleanup.
7. **When should `VACUUM FULL` be avoided?** Any table with live production
   traffic during business hours, unless a maintenance window can absorb the
   full duration of an `ACCESS EXCLUSIVE` lock. Prefer fixing the ROOT CAUSE
   (autovacuum tuning, shorter transactions) so bloat never accumulates
   enough to need a rewrite in the first place.

## Interview questions

1. Why does plain `VACUUM` not shrink a table's file on disk, while `VACUUM
   FULL` does - what has to be true for each one to be safe?
2. Why does `VACUUM FULL` need an `ACCESS EXCLUSIVE` lock specifically,
   rather than something weaker like `SHARE`?
3. A table's `n_live_tup` stays constant while `n_dead_tup` grows without
   bound. What real, single cause would produce exactly that pattern?
4. Why can a single long-running transaction elsewhere in the database
   prevent `VACUUM` from reclaiming dead tuples in a COMPLETELY different
   table?
5. What is transaction ID wraparound, and why does it make "just disable
   autovacuum for a while" a genuinely dangerous thing to do on a busy
   table, not just an inconvenience?
6. `autovacuum_vacuum_scale_factor` is a percentage of a table's live row
   count, not a fixed number. Why might that be the wrong default for both a
   10-row table and a 100-million-row table, for opposite reasons?
7. How would you prove, from OUTSIDE the database, that autovacuum actually
   ran on a specific table in the last hour - not just that dead tuples
   happen to be low right now?

## Further experiments

- Lower `scenario:bloat`'s `--passes` and watch `sizeGrowthRatio` shrink
  roughly proportionally - find the point where a handful of update passes
  is not yet worth calling "bloat."
- Run `scenario:vacuum --rows=150000 --passes=30` for a bigger, slower
  `VACUUM FULL` and see whether `vacuumFullBlockRatio` stays close to `1.0`
  as duration grows (predict first, then verify) - watch your machine's
  available `/dev/shm`/shared memory if you push this much further, very
  large in-container `VACUUM FULL` runs can exhaust a default Docker shm
  size.
- While `scenario:vacuum` is running its `VACUUM FULL` phase, open a second
  session and run
  `SELECT pid, mode, granted, relation::regclass FROM pg_locks WHERE relation = 'page_views'::regclass ORDER BY granted, pid;`
  - watch concurrent probe connections' lock requests sit at `granted =
  false` for the operation's duration.
- Change `autovacuum-recovery.ts`'s `autovacuum_vacuum_threshold` to a much
  larger number (e.g. `10000`) against the same 5,000-row table and confirm
  autovacuum now never triggers for this workload - reproducing, in
  miniature, exactly the "threshold set wrong for this table's size" failure
  mode "Production notes" describes.
- Query `SELECT relname, age(relfrozenxid) FROM pg_class JOIN pg_stat_user_tables USING (relname) WHERE relname = 'page_views';`
  before and after `scenario:autovacuum` runs, and read up on
  `autovacuum_freeze_max_age` to see how this lab's dead-tuple-driven
  autovacuum trigger relates to the separate, wraparound-driven freeze
  trigger this lab does not otherwise demonstrate.
