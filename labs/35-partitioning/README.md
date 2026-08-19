# Lab 35 - Partitioning: `PARTITION BY RANGE`/`LIST` and Why It Matters

## Why this exists

A time-series-shaped table - events, logs, metrics, audit trails - grows
without bound. Two production problems show up together, on the same table,
usually discovered in the same incident: queries that only ever care about
recent data get slower every month as the table grows underneath them, and
retention/cleanup jobs (`DELETE FROM events WHERE created_at < now() -
interval '90 days'`) start timing out or generating so much WAL and dead
tuple churn that they themselves become an operational problem. Both
problems have the same root cause: Postgres does not know, structurally,
that "old" and "new" rows live in different places - a single heap file
holds everything, and every operation that touches "a slice of time" has to
find that slice inside the whole.

Declarative partitioning fixes this by making time (or another key) a
structural property of the table, not just a column you happen to filter
on. `PARTITION BY RANGE (recorded_at)` splits one logical table into many
physical child tables, each responsible for a contiguous slice. A query
that only asks about one slice can be planned to touch only that slice's
table (**partition pruning**). A retention job that wants to delete an
entire slice can just detach and drop that slice's table (a catalog
operation) instead of scanning and deleting every row in it. This lab
builds the exact same dataset both ways - unpartitioned and partitioned -
and measures both payoffs with real `EXPLAIN ANALYZE` evidence, while being
equally honest about the query patterns and rules where partitioning helps
nothing or actively costs more.

## Learning objectives

After this lab you should be able to:

- read `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` output and identify, from
  the literal set of relations the plan touches, whether partition pruning
  actually happened - not infer it from "the query got faster";
- state precisely which query shapes benefit from RANGE partitioning
  (filtered on, or range-restricted by, the partition key) and which do not
  (no filter on the partition key at all), with real measured evidence for
  both;
- explain why `ALTER TABLE ... DETACH PARTITION` + `DROP TABLE` is a
  near-constant-time catalog operation while the equivalent `DELETE` is
  proportional to row count, and why that gap is the real, dominant reason
  production systems adopt partitioning;
- reproduce the real Postgres error a row produces when it matches no
  partition and there is no `DEFAULT` partition, and explain the two
  legitimate fixes (provision partitions ahead of time; add a `DEFAULT`
  partition) and when each is the right call;
- explain two real, easy-to-miss Postgres rules partitioning imposes:
  every unique constraint (including `PRIMARY KEY`) on a partitioned table
  must include the partition key, and a new partition automatically
  inherits the parent's indexes only if you create it (or attach a
  compatible one) after the parent's index already exists;
- contrast RANGE and LIST partitioning as the same mechanism applied to a
  continuous key (time) versus a discrete key (a fixed/slowly-growing
  category).

## Architecture

```text
metric_events_flat            <- Drizzle-managed, plain table, one B-tree index on recorded_at
metric_events_partitioned     <- hand-authored raw SQL, PARTITION BY RANGE (recorded_at)
  metric_events_y2025m01 .. metric_events_y2025m12   <- 12 monthly partitions, calendar year 2025
metric_events_by_region       <- hand-authored raw SQL, PARTITION BY LIST (region) - Point 5 bonus
  metric_events_by_region_us / _eu / _apac
```

Both `metric_events_flat` and `metric_events_partitioned` hold the *same
logical dataset*, seeded in lockstep by `src/seed/seed.ts` - a fleet of 300
IoT devices reporting 5 telemetry metrics (`temperature_c`, `humidity_pct`,
`pressure_hpa`, `battery_pct`, `vibration_mm_s`) across all of calendar year
2025. Not one of `SPEC.md` section 8.2's five named domains - device
telemetry is one of `SPEC.md` Lab 35's own example domains ("events / logs /
metrics"), and it is the canonical real-world fit for RANGE partitioning: a
fleet that never stops reporting, a table that never stops growing, and
almost every real query either wants a recent window (a dashboard) or wants
an old window gone (a retention policy) - exactly the two things this lab
measures.

**Only `metric_events_flat` is declared in `src/db/schema.ts` as a Drizzle
`pgTable()`.** `metric_events_partitioned` and `metric_events_by_region` are
deliberately **not** Drizzle schema objects - `drizzle-kit`'s schema-diffing
has no vocabulary for `PARTITION BY RANGE`/`PARTITION OF`/`ATTACH
PARTITION`/`DETACH PARTITION`. If either were declared as a `pgTable()`,
`drizzle-kit generate` would try to manage them as plain tables on every
future run and fight the hand-written DDL below. Per `CLAUDE.md`'s "ORM
plus SQL" principle, every partitioned-table migration
(`drizzle/0001_create_partitioned_table.sql`,
`drizzle/0002_create_list_partition_demo.sql`) and every partition
maintenance operation in this lab's scenario code talks to Postgres
directly through `pg`, with typed row-shape interfaces in place of Drizzle
query builders - the more honest tool for a lab whose entire point is
Postgres-specific DDL and planner behavior.

Two real, load-bearing schema differences the partitioned tables have that
the flat table does not, both forced by Postgres's own partitioning rules
(see "Fix it" below for the full explanation):

1. `PRIMARY KEY (id, recorded_at)` instead of `PRIMARY KEY (id)` alone -
   Postgres requires every unique constraint on a partitioned table to
   include the partition key.
2. `public_id` has an index but **no** `UNIQUE` constraint on
   `metric_events_partitioned` (unlike the flat table's real
   `UNIQUE(public_id)`) - a genuine, easy-to-miss limitation of RANGE
   partitioning, not an oversight.

```text
src/db/partitions.ts                          <- canonical partition layout + reconciliation helpers (raw SQL/pg_catalog)
src/seed/generator.ts                         <- deterministic, streamed/batched telemetry generator
src/seed/seed.ts                              <- --size=small|medium|large or --rows=N; seeds BOTH tables identically
src/scenarios/partition-lib.ts                <- shared EXPLAIN ANALYZE + timing helpers
src/scenarios/query-comparison.ts             <- Points 1-2: naive seq scan vs indexed flat vs partition pruning
src/scenarios/no-benefit-query.ts             <- Point 2: the honest counter-example (no partition-key filter)
src/scenarios/partition-maintenance.ts        <- Point 3: DETACH+DROP vs DELETE, real measured timing
src/scenarios/attach-and-missing-partition.ts <- Point 4: real captured error + ahead-of-time fix
src/scenarios/list-partitioning.ts            <- Point 5 (optional): LIST partitioning + DEFAULT partition
```

## Setup

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:migrate
pnpm seed                     # fast default: --size=small, 60,000 rows/table, ~1.3s
```

This README's numbers were captured at the large preset:

```bash
pnpm seed -- --size=large     # 1,200,000 rows/table (2,400,000 total); took
                               # ~24.7s on the machine this README's numbers
                               # were captured on (~97,000 rows/sec)
```

`pnpm seed` (no args) always defaults to `--size=small` so `pnpm test` and
casual `pnpm dev` runs stay fast, per `CLAUDE.md`'s Data Generation
guidance. `--rows=N` seeds an exact total (split evenly across the 12
months). Every `pnpm seed` run first reconciles both `metric_events_
partitioned` and `metric_events_by_region` back to their canonical
migrated-state layout (see `src/db/partitions.ts`), undoing whatever a
previous scenario run detached, dropped, or attached - seeding is fully
idempotent regardless of what state a prior demo left the database in.

## Scenario

You run the backend for a fleet-telemetry platform. A dashboard team wants
"last 7 days" and "this month" charts to stay fast as the fleet grows past a
year of history. Separately, the compliance team wants telemetry older than
a defined retention window purged - reliably, and without a multi-minute
`DELETE` blocking other traffic on the table. Today, everything lives in one
plain table (`metric_events_flat`).

## Prediction

Before running anything, write down answers to these:

1. `metric_events_flat` will have a plain B-tree index on `recorded_at`.
   Will a "last 7 days" query need partitioning at all to be fast, given
   that index already exists?
2. If you partition by month and then run a query with **no** filter on
   `recorded_at` at all (e.g., "average battery level for device X across
   all history"), will it get faster, slower, or about the same as the
   unpartitioned table?
3. You partition a table by month through December 2025 and it is now
   January 2026. What happens to the very first `INSERT` for a January 2026
   reading, if nobody has created that partition yet?

## Exercise

```bash
pnpm seed -- --size=large

pnpm scenario:query-comparison             # Points 1-2: naive vs indexed vs pruned
pnpm scenario:no-benefit-query             # Point 2: the honest counter-example
pnpm scenario:partition-maintenance        # Point 3: DETACH+DROP vs DELETE timing
pnpm scenario:attach-and-missing-partition # Point 4: real captured error + fix
pnpm scenario:list-partitioning            # Point 5 (optional): LIST + DEFAULT partition

pnpm seed                                  # restore a clean small dataset
pnpm test                                  # invariant tests, own isolated seeding/reconciliation
```

`partition-maintenance` and `attach-and-missing-partition` permanently
mutate the partition layout and row counts on purpose (that is the point);
each script's own log output tells you to re-run `pnpm seed` afterward, and
the next `pnpm seed` run always restores a clean canonical state regardless.

## Observe

- **`relationsScanned` in every scenario's log output** - the literal list
  of relations `EXPLAIN`'s own JSON plan says it touched. This is the
  single most important field in this lab: it is structural proof of
  pruning (or its absence), not an inference from timing.
- **`pnpm scenario:query-comparison` output** - `topNodeType`,
  `buffersTouched`, and `medianExecutionMs` for the naive/indexed/pruned
  variants of the same query, all real numbers Postgres itself reported.
- **PGweb** (`http://localhost:8435`) - browse `metric_events_partitioned`
  and expand it to see all 12 child partitions listed as separate tables;
  run `EXPLAIN (ANALYZE, BUFFERS) SELECT ... WHERE recorded_at >= ...` by
  hand in its query tab.
- `\d+ metric_events_partitioned` in `psql`/PGweb - shows the partition key,
  the list of partitions with their exact bounds, and which indexes are
  "partitioned indexes" spanning all children.
- `pg_inherits` / `pg_class` (see `src/db/partitions.ts`'s
  `listExistingPartitions`) - the real system-catalog query this lab uses
  instead of hardcoding partition names, useful any time you need to answer
  "what partitions does this table actually have right now?" by hand.

## Break it

Run the missing-partition scenario:

```bash
pnpm scenario:attach-and-missing-partition
```

Real, captured output from this repository:

```text
--- Point 4: inserting a row with no matching partition, and no DEFAULT partition to catch it ---
  row: { deviceId: "dev-0001", metric: "temperature_c", value: 21.4, recordedAt: "2026-01-15T00:00:00Z" }

REAL CAPTURED FAILURE: Postgres rejected the insert
  postgresErrorCode: "23514"
  message: 'no partition of relation "metric_events_partitioned" found for row'
```

This is a **real captured Postgres error**, SQLSTATE `23514`
(`check_violation`) - not a simulated or asserted-in-application-code
failure. It happens because this table's migration
(`drizzle/0001_create_partitioned_table.sql`) deliberately only provisions
partitions for calendar year 2025, and deliberately has **no** `DEFAULT`
partition. Any row whose `recorded_at` falls outside every existing
partition's range - here, January 2026 - has nowhere to go, and Postgres
refuses the insert outright rather than silently dropping or misfiling it.

The same class of failure, reproduced against the Point 5 LIST-partitioned
table for a discrete key instead of a time range:

```text
REAL CAPTURED FAILURE: 'latam' has no matching LIST partition and there is no DEFAULT partition
  postgresErrorCode: "23514"
  message: 'no partition of relation "metric_events_by_region" found for row'
```

## Fix it

Two legitimate fixes exist, and this lab demonstrates both, deliberately in
different places:

**1. Provision the partition ahead of time** (used for the main RANGE
table, `attach-and-missing-partition.ts`) - the right fit when the key
space is predictable and grows on a known schedule, like "the next calendar
month always needs a partition eventually." Real captured output from the
same run as above, immediately following the failure:

```text
FIX: provisioned the missing partition ahead of the data that needs it
  sql: "CREATE TABLE metric_events_y2026m01 PARTITION OF metric_events_partitioned FOR VALUES FROM ('2026-01-01') TO ('2026-02-01')"

RETRY SUCCEEDED: the exact same insert that failed a moment ago now lands cleanly in metric_events_y2026m01
  insertedId: "1200002"
```

In production this is a scheduled job (a cron job, a migration run on
deploy, a Postgres extension like `pg_partman`) that creates next month's
partition **before** the month starts - the scenario script also shows
this directly by provisioning February 2026 proactively, with no failed
insert forcing its hand:

```text
OPERATIONAL DISCIPLINE: this is what a scheduled job should do BEFORE
February 2026 ever produces a single row - partition maintenance has to
run ahead of the data, not react to it
  sql: "CREATE TABLE metric_events_y2026m02 PARTITION OF metric_events_partitioned FOR VALUES FROM ('2026-02-01') TO ('2026-03-01')"
```

**2. Add a `DEFAULT` partition** (used for the Point 5 LIST table,
`list-partitioning.ts`) - the right fit when the key space is not fully
known ahead of time (a new, rarely-seen category value), and "catch it
somewhere rather than reject it" is an acceptable tradeoff. Real captured
output:

```text
FIX: attached a DEFAULT partition to catch any region not explicitly listed
RETRY SUCCEEDED: the same insert now lands in the DEFAULT partition
  insertedId: "6"
  region: "latam"
```

Both fixes are shown as real DDL against a real, running Postgres instance,
not pseudocode.

## Why the fix works

**Partition pruning** (Points 1-2). Real, captured output at
`--size=large` (1,200,000 rows/table) for `SELECT count(*), avg(value)
... WHERE recorded_at >= '2025-06-09' AND recorded_at < '2025-06-16'` (a
7-day window entirely inside June), median of 5 real `EXPLAIN (ANALYZE,
BUFFERS, FORMAT JSON)` runs:

| Variant | Median execution time | Buffers touched | Relations scanned |
| --- | ---: | ---: | --- |
| `metric_events_flat`, **no index** (naive) | 25.769 ms | 54,552 | 1 (full scan) |
| `metric_events_flat`, **indexed** on `recorded_at` | 5.256 ms | 46,806 | 1 |
| `metric_events_partitioned` | 3.373 ms | **2,502** | **1** (`metric_events_y2025m06`) |

The indexed-flat-vs-naive gap (4.9x) is an **indexing** win, not a
partitioning win - be honest about that, per this lab's own brief. The
partitioned table's real edge over the indexed flat table is the buffer
count: **2,502 vs 46,806, an 18.7x reduction** - the planner's own
`relationsScanned` field proves why: it touched exactly one 100,000-row
child table and its much smaller local index, never the other eleven
months' worth of index entries at all. A query spanning the June/July
boundary (`2025-06-28` to `2025-07-05`) correctly prunes to **exactly the 2
overlapping partitions**, not 1 and not all 12 - pruning targets whatever
partitions the filter can overlap, not always a single one.

**The honest counter-example** (Point 2, `no-benefit-query.ts`). The same
1,200,000-row/table dataset, querying "all-time average for one device"
(`WHERE device_id = 'dev-0007'`, no filter on `recorded_at` at all):

| Variant | Median execution time | Buffers touched | Partitions touched |
| --- | ---: | ---: | ---: |
| `metric_events_flat` (indexed on `recorded_at`, useless here) | 26.334 ms | 54,552 | n/a (1 relation) |
| `metric_events_partitioned` | 22.818 ms | **68,225** | **12 of 12** |

`relationsScanned` lists all 12 monthly partitions - zero pruning is
possible, because the filter says nothing about the partition key. The
buffer count is the honest, deterministic signal here: partitioning touched
**more** total buffers (68,225 vs 54,552) because it had to walk 12
separate, smaller per-partition indexes and `Append` the results, instead
of one larger index. Wall-clock time in this run landed close to (even
slightly under) the flat table's - Postgres genuinely executes 12 small
per-partition scans efficiently - but that is a property of this
machine/dataset, not a guarantee; the buffer count is the metric that does
not depend on cache warmth or CPU noise. The takeaway is structural, not
"partitioning made this slower": **for a query that never filters on the
partition key, partitioning provides no pruning benefit and adds Append/
per-partition planning overhead** on top of doing strictly more index
lookups.

**Partition maintenance** (Point 3, `partition-maintenance.ts`) - the
bigger, non-query-time payoff. Purging January's data via `ALTER TABLE ...
DETACH PARTITION` + `DROP TABLE`, versus the equivalent `DELETE FROM
metric_events_flat WHERE recorded_at >= '2025-01-01' AND recorded_at <
'2025-02-01'`, same row count, same machine, real measured durations at
three real dataset sizes:

| Rows removed | DETACH+DROP total | DELETE | Speedup |
| ---: | ---: | ---: | ---: |
| 5,000 | 7.058 ms | 5.879 ms | 0.8x (DETACH+DROP's fixed catalog-operation overhead dominates at this size) |
| 50,000 | 5.510 ms | 24.253 ms | 4.4x |
| 100,000 | 4.892 ms | 68.225 ms | **13.9x** |

This progression is the real point, not any single ratio: **DETACH+DROP's
cost stays flat (~5-7 ms) regardless of row count**, because it never reads
or writes a single row of January's data - it unlinks a catalog entry and
removes a file. **`DELETE`'s cost grows roughly with row count**
(5.879 ms at 5K rows, 24.253 ms at 50K, 68.225 ms at 100K), because
Postgres must find every matching row via the index, mark each one as a
dead tuple (MVCC), and write a WAL record for every affected page. At small
row counts DETACH+DROP's fixed overhead can even exceed a fast `DELETE`'s
cost (the 0.8x row above) - the crossover itself is evidence that
DETACH+DROP truly is a constant-time operation, not merely "usually
faster." At real production retention-window sizes (hundreds of thousands
to millions of rows per period), the gap is not close.

**Two Postgres rules this lab surfaced directly, empirically, while
building it** (see `src/db/schema.ts` / migration comments for where they
bite):

1. `PRIMARY KEY`/`UNIQUE` on a partitioned table must include the partition
   key. `metric_events_partitioned`'s primary key is `(id, recorded_at)`,
   not `(id)` alone, and `public_id` only has a plain index, not a `UNIQUE`
   constraint, because Postgres would reject `UNIQUE(public_id)` alone on a
   table partitioned by `recorded_at`.
2. An index created on the parent **before** a partition exists is
   automatically created on that partition too, the moment it is added via
   `CREATE TABLE ... PARTITION OF ...` - verified directly against this
   lab's own Postgres 16 instance while building it. This is why this lab's
   migration creates `CREATE INDEX ON metric_events_partitioned
   (recorded_at)` immediately after the parent table, before any of the 12
   monthly `CREATE TABLE ... PARTITION OF ...` statements - each of them
   gets a matching local index "for free," with zero additional `CREATE
   INDEX` statements.

## Tradeoffs

| | Unpartitioned (indexed) | RANGE-partitioned |
| --- | --- | --- |
| Query filtered on the partition key | Fast (index scan) | Faster still (index scan over a much smaller local index; real measured 18.7x fewer buffers at this lab's scale) |
| Query NOT filtered on the partition key | Fast (one relation, one scan) | No pruning possible - real measured MORE total buffers touched (Append over every partition) |
| Bulk delete of an old, well-defined time range | Proportional to row count (real measured 68.225 ms for 100K rows) | Near-constant catalog operation (real measured 4.892 ms for the same 100K rows) |
| `UNIQUE`/`PRIMARY KEY` on a non-partition-key column | Fully supported | Must include the partition key, or cannot be a true global uniqueness guarantee |
| New partition indexing | N/A (one table, one set of indexes) | Automatic IF the parent's index existed before the partition was created - otherwise a real, silent gap |
| Operational discipline required | None beyond normal indexing/vacuuming | Partition provisioning must run AHEAD of incoming data (a scheduled job, or a `DEFAULT` partition as a safety net) - a real, ongoing maintenance burden |
| Schema/migration complexity | Low (one `CREATE TABLE`) | Higher - Drizzle's schema DSL cannot express `PARTITION BY`/`PARTITION OF` at all; this lab hand-writes that DDL as raw SQL migrations (see "Architecture") |
| Cross-partition joins/aggregates | N/A (already one table) | Postgres still presents one logical table - correctness is unaffected, but the planner does more work (Append, per-partition costing) |

Partitioning is not "free" and not universal. It trades query-time wins
that are real but often incremental on top of a good index, for a
substantial *operational* win (retention/purge cost) and a real, ongoing
maintenance obligation (partitions must exist before data needs them, or
you get the exact failure this lab reproduces in "Break it").

## Production notes

1. **What guarantee does this mechanism give?** Postgres guarantees that
   each row lives in exactly one partition, determined solely by the
   partition key at insert/update time, and that a query's `WHERE` clause
   can be proven (at plan time or, for parameterized queries, at execution
   time) to eliminate partitions that cannot contain matching rows. It does
   not change any transactional or MVCC guarantee - a partitioned table is
   still fully transactional, still uses the same isolation levels, still
   subject to the same vacuum/bloat mechanics per-partition.
2. **What guarantee does it not give?** It does not guarantee faster
   queries for every access pattern (see the honest counter-example
   above), does not give you a global `UNIQUE` constraint on a
   non-partition-key column, and does not automatically create matching
   indexes on partitions attached from pre-existing standalone tables
   unless you created a compatible index on that table first.
3. **What failure mode remains?** A row whose partition key value falls
   outside every existing partition's range, with no `DEFAULT` partition,
   is rejected outright (real captured `23514` in this lab). If partition
   provisioning lags behind real traffic (the scheduled job didn't run,
   was delayed, or crashed), every insert for the missing period fails
   until an operator intervenes - this is the single most common
   partitioning production incident.
4. **How does contention affect it?** `DETACH PARTITION` (non-concurrent,
   as used in this lab) briefly takes an `ACCESS EXCLUSIVE` lock on the
   parent table while it updates the partition descriptor - fast (this
   lab's measured 2-3 ms), but real, and blocking for any concurrent
   query/write touching the parent during that instant. Postgres 14+ also
   offers `ALTER TABLE ... DETACH PARTITION ... CONCURRENTLY`, which avoids
   holding that lock for the whole operation at the cost of a longer,
   two-phase detach - the right choice on a busy production table where
   even a few milliseconds of `ACCESS EXCLUSIVE` is unacceptable; this lab
   uses the simpler non-concurrent form since it is a single-node,
   non-production instance.
5. **What changes at larger scale?** The core economics only get more
   favorable for partitioning: `DELETE`'s cost keeps growing linearly with
   row count while `DETACH`+`DROP`'s stays flat, so the crossover point
   this lab measured (somewhere between 5,000 and 50,000 rows) moves
   further in partitioning's favor as tables grow into the tens or
   hundreds of millions of rows. The number of partitions itself becomes a
   real planning-time cost too, though - very high partition counts (many
   thousands) measurably slow down planning for queries that must Append
   across all of them, which is one reason production partition schemes
   pick a granularity (monthly here; sometimes weekly or daily for very
   high-volume tables) that keeps partition counts in the dozens-to-low-
   hundreds range, not thousands.
6. **What metrics would be monitored?** Count and age of partitions versus
   the retention/provisioning schedule (an early-warning signal for "the
   next partition isn't created yet"); `pg_stat_user_tables` per partition
   for bloat/vacuum health, since partitions are independently vacuumed;
   failed-insert rate/error code `23514` specifically, as a direct signal
   of provisioning lag; query latency broken out by whether the plan shows
   pruning (a regression here often means a query changed to no longer
   filter on the partition key, or the filter became un-prunable, e.g. a
   function applied to the partition column).
7. **When should this approach be avoided?** Small or slow-growing tables
   where an index alone already answers every real query fast enough -
   partitioning adds real schema/migration/operational complexity (this
   lab's own raw-SQL-migration workaround for Drizzle being one small
   example) for a payoff that mostly matters at scale. Also avoid it when
   the natural partition key does not match real query patterns - if most
   queries filter on something other than the column you would partition
   by, you get this lab's honest counter-example (Append over everything)
   as your default case, not your exception.

## Interview questions

1. How do you prove, from `EXPLAIN` output alone, that partition pruning
   actually happened for a given query - as opposed to inferring it from
   the query simply running fast?
2. Why does a query filtered on a column other than the partition key get
   no benefit from RANGE partitioning, and can it ever get actively slower?
   What evidence would you look for either way?
3. Why is `ALTER TABLE ... DETACH PARTITION` + `DROP TABLE` close to
   constant-time regardless of row count, while `DELETE FROM table WHERE
   ...` covering the same rows is not? What is Postgres actually doing (or
   not doing) differently in each case?
4. A row insert fails with SQLSTATE `23514`, "no partition of relation ...
   found for row." What are the two legitimate fixes, and what factors
   would make you choose a `DEFAULT` partition over provisioning the
   correct partition ahead of time (or vice versa)?
5. Why must a `PRIMARY KEY` on a partitioned table include the partition
   key column? What does this cost you if the column you actually wanted
   to be globally unique is not the partition key?
6. You create a brand-new partition and forget to give it a matching
   index. Under what circumstance does Postgres create that index for you
   automatically, and under what circumstance does it not?
7. What operational job or process needs to exist, on an ongoing basis,
   for a production RANGE-partitioned-by-month table to keep working
   correctly six months from now? What happens if that job silently stops
   running?
8. LIST and RANGE partitioning share the same missing-partition failure
   mode. Why might a team choose a `DEFAULT` partition for one of these
   tables and ahead-of-time provisioning for the other, even though both
   are partitioned by the same underlying mechanism?

## Further experiments

- Reseed at `--size=medium` or your own `--rows=N` and re-run
  `scenario:partition-maintenance` - does the DETACH+DROP-vs-DELETE
  crossover point (this README measured it somewhere between 5,000 and
  50,000 rows) move if you change the machine, or Postgres's
  `shared_buffers`?
- Change `query-comparison.ts`'s window to span 3+ months instead of a
  single week, and re-run - watch `relationsScanned` grow past 2 partitions
  and confirm the count matches exactly the number of calendar months the
  window overlaps.
- Add `ALTER TABLE metric_events_partitioned DETACH PARTITION
  metric_events_y2025m06 CONCURRENTLY` (Postgres 14+) instead of the
  non-concurrent form this lab uses, and compare its real duration and
  locking behavior (check `pg_locks` from a second session mid-operation)
  against the plain `DETACH PARTITION` this lab measures.
- Deliberately create a partition WITHOUT first ensuring the parent's index
  exists (drop the parent's `recorded_at` index, then create a new
  partition, then recreate the parent index) - inspect `\d+` on the new
  partition and confirm whether it received a matching local index, to see
  the "silent gap" this README's production notes warn about directly.
- Extend `list-partitioning.ts` to add a 4th named region partition after
  data already exists in the `DEFAULT` partition for that region's rows,
  and see what Postgres requires you to prove before it lets you do that
  (`ALTER TABLE ... ATTACH PARTITION` refuses if rows that belong in the
  new partition are still sitting in `DEFAULT`, unless you move them
  first).
- Look up `pg_partman` (a widely used Postgres extension for automated
  partition creation/retention) and compare its automated approach against
  this lab's hand-rolled `reconcileCanonicalPartitionLayout` - what would
  change about the production notes above if partition provisioning were
  fully automated instead of a hand-run scheduled job?
