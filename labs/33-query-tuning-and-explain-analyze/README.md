# Lab 33 - Query Tuning and EXPLAIN ANALYZE

## Why this exists

Lab 04 taught you that a missing index turns a lookup into a sequential
scan, and that adding the right index fixes it - a clean, one-shot story.
Real production query tuning is messier than that: the planner's own row
ESTIMATE can be badly wrong even when every index it needs already exists,
adding an index doesn't always change the plan the way you expect, and a
"fixed" query can touch MORE buffer blocks than the "slow" one while still
running faster in wall-clock time. This lab exists to build the actual
discipline: read a real `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` plan
correctly, tell the planner's ESTIMATE apart from what actually happened,
form a hypothesis about WHY a plan is slow, and verify a fix with real
before/after numbers - not guesses, and not stopping at "it got faster."

## Learning objectives

After this lab you should be able to:

- read `EXPLAIN (ANALYZE, BUFFERS)` output (text or JSON) and separate the
  planner's `Plan Rows` ESTIMATE from the executor's real `Actual Rows`,
  and explain what a large gap between them means for plan quality;
- explain two structurally different reasons a row estimate can be wrong -
  stale statistics (fixed by `ANALYZE`) and correlated columns (fixed by
  `CREATE STATISTICS`, which `ANALYZE` alone cannot address) - and why the
  two fixes are not interchangeable;
- explain why Postgres will not use a plain index to serve a query that
  applies a function to the indexed column (`date_trunc(...)`,
  `lower(...)`), and choose between an expression index and a sargable
  query rewrite as the fix, with a real cost/benefit reason for each;
- read a real `EXPLAIN ANALYZE` plan for a multi-table `JOIN` and identify
  which scan/join strategy the planner chose and why, including cases where
  an index exists but the planner correctly declines to use it for a
  particular query shape;
- explain why Postgres's own per-node `Buffers` counters in `EXPLAIN
  (ANALYZE, BUFFERS, FORMAT JSON)` output are CUMULATIVE (a parent node's
  count already includes every descendant's) rather than exclusive, and why
  naively summing every node's buffer count over-counts by a large margin;
- explain, with a real measured number from THIS lab's own data, why
  "touches more buffer blocks" and "runs slower" are not the same claim -
  sequential and random I/O are not equally expensive per buffer touched;
- discuss the write-amplification/maintenance cost of every index this lab
  adds, and explain why one well-chosen index can legitimately serve
  several different query shapes instead of each shape getting its own.

## Architecture

```text
customers ──1:N── orders ──1:N── order_lines ──N:1── products
```

Domain: **commerce**, reused in SHAPE from Lab 03/04 (`customers`,
`products`, `orders`, `order_lines`) - a fresh, independent copy per the
independent-labs principle, not imported from either lab, seeded via the
EXISTING `generateCustomers`/`generateProducts`/`generateOrdersBatched`
generators in `packages/data-generators/src/commerce.ts` as-is. This lab
adds exactly one new column beyond that shape: `orders.channel`
(`web`/`mobile`/`phone`/`store`), generated LOCALLY in `src/seed/seed.ts`
(via `src/seed/generate-channel.ts`) rather than added to the shared
generator, since no other lab needs it - see "Domains by lab" in
`ROADMAP.md`.

`channel` exists for exactly one reason: it is deliberately CORRELATED with
`status` at the data level. A cancelled order in this dataset has an 85%
chance of `channel = 'phone'` (a customer calling in to cancel); every other
status's channel is close to uniform across all four values. This manufactured
correlation is what makes Pattern 1b's row-estimate problem real and
reproducible instead of hypothetical.

Two migrations, on purpose (the same convention Lab 04 established):

```text
drizzle/0000_loving_eternals.sql     <- base tables, no performance indexes
drizzle/0001_add_tuning_fixes.sql    <- 4 indexes + 1 extended statistics object, hand-written raw SQL
```

`0001` is a **hand-written custom migration** (`drizzle-kit generate
--custom`), not one produced by diffing `src/db/schema.ts` - expression
indexes and `CREATE STATISTICS` have inconsistent-to-nonexistent
drizzle-kit support. Per `CLAUDE.md`'s "ORM plus SQL" principle, raw SQL is
the clearer, more honest tool here.

**Each pattern's naive/fixed scenario scripts own their own before-state.**
Exactly like Lab 04's `before-indexing.ts`, every `*-naive.ts` script
explicitly `DROP`s (or otherwise undoes) exactly the fix it's about before
measuring, so it produces an honest "before" state regardless of what
`pnpm db:migrate` or an earlier scenario run already did. This means
patterns are safe to run in any order, but Pattern 1's naive script is the
one exception worth knowing about: it PERMANENTLY mutates seeded data (a
bulk `UPDATE`, not a `DROP INDEX`) - see "Tradeoffs" below.

**One index deliberately serves three patterns.** `idx_orders_placed_at`
(a plain B-tree on `orders.placed_at`) is Pattern 2's fix, Pattern 3's
"preferred, no-new-index" Fix B, and Pattern 4's fix - reused, not
reinvented three times. This is intentional: CLAUDE.md's Query Performance
section says not to add indexes blindly, and "does one index earn its keep
across several real query shapes" is a genuine production question, not
just a lab convenience.

The 4 indexes and 1 extended statistics object (single source of truth:
`src/scenarios/index-definitions.ts`, mirrored in
`drizzle/0001_add_tuning_fixes.sql`):

| # | Fix | Type | Pattern | Target query shape |
|---|-----|------|---------|---------------------|
| 1 | `idx_orders_status` | plain B-tree | 1a | a stats-driven plan choice going stale |
| 2 | `orders_status_channel_stats` | extended statistics (`dependencies, mcv`) | 1b | correlated-columns row estimate |
| 3 | `idx_orders_placed_at` | plain B-tree | 2 / 3 / 4 | date-range join filter, sargable rewrite, `ORDER BY ... LIMIT` |
| 4 | `idx_order_lines_order_id` | plain B-tree | 2 | join back from `order_lines` to `orders` |
| 5 | `idx_orders_month_expr` | expression (`date_trunc('month', placed_at AT TIME ZONE 'UTC')`) | 3 | non-sargable month-bucket filter, Fix A |

**Why `AT TIME ZONE 'UTC'` in the expression index.** `date_trunc('month',
placed_at)` on a `timestamptz` column is only `STABLE` (its result depends
on the session's `timezone` setting) - Postgres refuses to build an index
on a non-`IMMUTABLE` expression ("functions in index expression must be
marked IMMUTABLE"), a real error this lab's own development hit on the
first attempt. `... AT TIME ZONE 'UTC'` first converts to a zone-less
`timestamp` representing that instant's UTC wall-clock time;
`date_trunc('month', timestamp)` on a zone-less value has no session state
left to depend on, so it IS immutable.

**A second real timezone gotcha this lab's own development hit and fixed**:
node-pg parses a Postgres `timestamp without time zone` value using the
HOST's local timezone, not UTC. Round-tripping
`date_trunc('month', placed_at AT TIME ZONE 'UTC')`'s result through a JS
`Date` object and back (as this lab's scenario scripts originally did)
silently shifted every month boundary by the host's UTC offset on any
non-UTC host - on the UTC+3 host this lab was built on, a real captured bug
turned `2026-05-01 00:00:00` into a `Date` for `2026-04-30T21:00:00Z`,
corrupting Pattern 3's Fix B date range to a 3-hour window instead of a
month. The fix, in `src/scenarios/sample-window.ts`: do the date math in
SQL, return pre-formatted TEXT (`to_char(...)`), and bind that text
directly as a query parameter - Postgres parses `timestamp`-typed text
literally with no timezone involved at all, and `timestamptz`-typed text
only when an explicit `Z`/`+00` suffix is present (see `asUtcInstant`).

**A third real gotcha this lab's own development hit**: Postgres's
per-node `Buffers` counters in `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`
output are CUMULATIVE - a node's `Shared Hit Blocks`/`Shared Read Blocks`
already include every descendant node's. This lab's `explain-json.ts`
originally summed every node's buffer counts together, which
over-counted a real query's total buffer usage by roughly 7x (61,231
summed vs. 8,995 actual, confirmed by checking that a root `Sort` node's
own count was within a few dozen pages of its immediate child's count, not
the sum of the whole subtree). The fix: use ONLY the root node's count as
the query's total.

## Setup

```bash
pnpm install
cp labs/33-query-tuning-and-explain-analyze/.env.example labs/33-query-tuning-and-explain-analyze/.env
cd labs/33-query-tuning-and-explain-analyze
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate    # applies BOTH migrations (base tables + tuning fixes)
pnpm seed --size=small   # fast sanity check: ~300 customers, ~3.6k orders+lines, well under a second
```

Open PGweb at http://localhost:8433 (auto-connects via `PGWEB_DATABASE_URL`).

**The real experiment needs a much larger dataset.** On this machine,
`pnpm seed --seed=42 --size=large` generated 40,000 customers, 400
products, 199,895 orders, and 601,142 order_lines (801,037 combined
orders+order_lines rows) in **~24 seconds** (~33,500 rows/sec),
streaming/batching inserts the whole way (same technique Lab 04
established):

```bash
pnpm seed --seed=42 --size=large
```

## Scenario

The same commerce business from Lab 03/04 runs four real, distinct reports
and lookups against its `orders`/`order_lines` tables:

1. **Fraud/ops review**: "how many cancelled orders came in by phone?" - a
   two-column filter where the columns are NOT independent of each other.
2. **Weekly revenue report**: "paid orders from last week, with customer
   name and per-order revenue" - a 3-table join filtered by a date range.
3. **Monthly reporting**: "all orders placed in March" - a natural,
   common query shape that happens to not be sargable as written.
4. **Recent activity feed**: "the 20 most recent orders, across the whole
   store" - `ORDER BY ... LIMIT` with no `WHERE` clause at all.

Every one of these either gets a badly wrong row estimate, a full
sequential scan, or an unnecessary full-table sort - and CLAUDE.md's Query
Performance discipline applies to fixing every one of them: **measure ->
inspect the query plan -> form a hypothesis -> modify -> measure again.**

## Prediction

Before running anything, predict:

1. `idx_orders_status` already exists and correctly serves
   `WHERE status = 'cancelled'` when cancelled orders are a rare ~8%
   minority. If a bulk data-migration event permanently recategorizes tens
   of thousands of other orders to `'cancelled'` afterward, does the
   planner's row ESTIMATE for that same query change on its own, or does it
   need something to happen first?
2. `orders.status` and `orders.channel` both have accurate, freshly
   `ANALYZE`d single-column statistics. Will
   `WHERE status = 'cancelled' AND channel = 'phone'` get an accurate row
   estimate anyway? Why or why not?
3. `date_trunc('month', placed_at AT TIME ZONE 'UTC') = ?` and
   `placed_at >= ? AND placed_at < ?` are logically equivalent for a whole
   calendar month. Will they get the same query plan if only a plain index
   on `placed_at` exists (no expression index)?
4. A 3-table join filtered to a narrow ~1-week date range has an index
   available on both `orders.placed_at` AND `order_lines.order_id`. Does
   the planner necessarily use both?
5. Will the "fixed" version of the join in question 4 necessarily touch
   FEWER buffer blocks than the naive version, given that it's faster?

## Exercise

Run the setup commands above, including `pnpm seed --seed=42 --size=large`,
then work through each pattern's naive script followed by its fixed
script:

```bash
pnpm scenario:pattern1-naive   # bad row estimates: stale stats + correlated columns
pnpm scenario:pattern1-fixed   # ANALYZE + CREATE STATISTICS

pnpm scenario:pattern2-naive   # missing-index JOIN
pnpm scenario:pattern2-fixed   # both indexes present

pnpm scenario:pattern3-naive   # non-sargable function-in-WHERE
pnpm scenario:pattern3-fixed   # Fix A (expression index) vs Fix B (rewrite)

pnpm scenario:pattern4-naive   # ORDER BY + LIMIT, no supporting index
pnpm scenario:pattern4-fixed   # index present, no Sort node needed

pnpm scenario:write-amplification --count=20000   # run once with 0/4 indexes, once with 4/4
```

Each script logs the full parsed `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`
plan (every node: type, estimated vs actual rows, buffers) plus a
summarized warning/info line with the numbers that matter most - see
"Observe" below for what to look at.

## Observe

- **PGweb** (http://localhost:8433): the "Indexes" tab on `orders` and
  `order_lines` after `pnpm db:migrate` - 4 new indexes, sizes visible.
- **Structured logs**: every scenario script logs through `@labs/logging`
  (Pino), including the full flattened plan tree
  (`src/scenarios/explain-json.ts`'s `explainAnalyzeJson`) - node type,
  relation/index name, filter/index condition, `Plan Rows` (estimate) vs
  `Actual Rows` (reality), and per-node `Shared Hit/Read Blocks`.
- **`pg_stats` / `pg_stats_ext`**: `SELECT * FROM pg_stats WHERE tablename
  = 'orders' AND attname = 'status'` for ordinary single-column stats;
  `SELECT * FROM pg_stats_ext WHERE statistics_name =
  'orders_status_channel_stats'` for the extended statistics Pattern 1b
  adds.
- **`pg_indexes`**: `SELECT indexname, tablename FROM pg_indexes WHERE
  schemaname = 'public'` to see exactly which indexes exist right now.

## Break it

### Pattern 1 - bad row estimates

Run `pnpm scenario:pattern1-naive`. Real output from this lab's own
validation run (seed 42, `--size=large`: 199,895 orders, 15,960 (7.98%)
cancelled at seed time):

**1b - correlated columns, measured first on pristine data** (fresh
`ANALYZE`, no extended statistics object yet):

```text
query: WHERE status = 'cancelled' AND channel = 'phone'
estimated rows: 4,766      (independence assumption: P(cancelled) * P(phone) * total)
actual rows:   14,089
divergence:     2.96x undercount
plan: Bitmap Heap Scan (idx_orders_status) + Filter channel = 'phone'
```

The real distribution behind that estimate: of 15,960 cancelled orders,
14,089 (88.3%) are `channel = 'phone'` - nowhere close to what independent
single-column statistics would predict.

**1a - stale statistics** (a bulk recategorization: 50,000 non-cancelled
orders flipped to `'cancelled'`, `ANALYZE` deliberately NOT run afterward):

```text
cancelled fraction before the bulk UPDATE: 7.98%  (15,960 / 199,895)
cancelled fraction after the bulk UPDATE: 33.00%  (65,960 / 199,895)
planner's estimated rows (stale stats):    19,841
actual rows:                               65,960
divergence:                                 3.32x undercount
plan: still Bitmap Heap Scan using idx_orders_status
```

`idx_orders_status` was a perfectly correct index choice when cancelled
orders were an 8% minority. Nothing about the index changed - only the
data did, and the statistics describing it did not follow.

### Pattern 2 - missing-index JOIN

Run `pnpm scenario:pattern2-naive`. Real output (a 7-day window, ~2,068
matching paid orders):

```text
matching orders: 2,068
execution time: 36.084 ms
total buffers (root node, cumulative): 8,995 hit / 0 read
plan: Sort -> Aggregate -> Gather -> Aggregate -> Hash Join(Hash Join(Seq Scan order_lines, Hash(Seq Scan orders)), Hash(Seq Scan customers))
```

Both `orders` (filtered by `placed_at` range + `status`) and `order_lines`
(joined back via `order_id`, a foreign key Postgres never indexes
automatically) are sequentially scanned in full.

### Pattern 3 - non-sargable function in WHERE

Run `pnpm scenario:pattern3-naive`. Real output (the busiest calendar
month in this dataset, January 2026, 17,175 orders):

```text
query: WHERE date_trunc('month', placed_at AT TIME ZONE 'UTC') = '2026-01-01'
estimated rows: 999
actual rows:   17,175            (17.2x undercount - a generic default guess, no matching expression statistics exist)
execution time: 14.239 ms
total buffers: 2,272 hit / 0 read
plan: Gather -> Parallel Seq Scan on orders
```

### Pattern 4 - ORDER BY + LIMIT without a supporting index

Run `pnpm scenario:pattern4-naive`. Real output:

```text
execution time: 18.167 ms
total buffers: 2,309 hit / 0 read
plan: Limit -> Gather Merge -> Sort -> Seq Scan on orders
```

To return the 20 MOST RECENT orders, Postgres reads and sorts (almost) the
entire 199,895-row table - there is no way to retrieve rows in
`placed_at DESC` order other than reading them all and sorting, without an
index.

## Fix it

### Pattern 1 fixed

Run `pnpm scenario:pattern1-fixed`:

```text
1a - ANALYZE alone:
  estimated rows: 66,378
  actual rows:    65,960
  divergence:     0.99x  (essentially exact)
  ANALYZE elapsed: 56 ms

1b - CREATE STATISTICS (dependencies, mcv) + ANALYZE:
  estimated rows: 26,613
  actual rows:    26,414   (measured AFTER 1a's bulk recategorization already ran - see "Tradeoffs")
  divergence:     0.99x
  CREATE STATISTICS + ANALYZE elapsed: 56 ms
```

`ANALYZE` alone fixed 1a completely (it just needed fresh single-column
statistics). It did **not** fix 1b - rerunning the correlated query with
only fresh single-column stats still undercounts, because no amount of
per-column accuracy can express "these two columns are correlated."
`CREATE STATISTICS` is what actually closes that gap.

### Pattern 2 fixed

Run `pnpm scenario:pattern2-fixed`:

```text
execution time: 20.206 ms     (36.084 ms -> 20.206 ms, ~44% faster)
total buffers: 10,402 hit / 925 read = 11,327 total   (8,995 -> 11,327, ~26% MORE buffer touches)
plan: Sort -> Aggregate -> Gather -> Aggregate -> Nested Loop(Hash Join(Bitmap Heap Scan orders via idx_orders_placed_at, Hash customers), Index Scan order_lines via idx_order_lines_order_id)
```

Read that buffer number again: the FIXED plan touches MORE buffer blocks
in total than the naive one, and is still 44% faster. See "Why the fix
works" for why that is not a contradiction.

### Pattern 3 fixed

Run `pnpm scenario:pattern3-fixed` - both fixes, back to back:

```text
Fix A (expression index on date_trunc('month', placed_at AT TIME ZONE 'UTC'), + ANALYZE):
  estimated rows: 16,884   actual: 17,175   (1.02x - accurate)
  execution time: 4.496 ms     (14.239 -> 4.496 ms, ~3.2x faster)
  total buffers: 2,272 hit / 16 read
  plan: Bitmap Heap Scan via idx_orders_month_expr

Fix B (rewritten sargable range query, reusing the plain placed_at index, + ANALYZE):
  estimated rows: 16,989   actual: 17,175   (1.01x - accurate)
  execution time: 3.334 ms     (14.239 -> 3.334 ms, ~4.3x faster)
  total buffers: 2,322 hit / 0 read
  plan: Bitmap Heap Scan via idx_orders_placed_at
```

Both fixes work. Fix B is slightly faster here AND requires no new,
single-purpose index - it reuses the exact same `idx_orders_placed_at`
Pattern 2 and Pattern 4 already need. See "Tradeoffs" for why Fix B is the
one to prefer when a rewrite is possible.

**A real gotcha this run also surfaced**: `CREATE INDEX` alone did **not**
fix the row estimate - the first time this script ran with no explicit
`ANALYZE` after `CREATE INDEX idx_orders_month_expr`, the estimate stayed
at exactly the naive query's wrong value (999), because Postgres has no
statistics for a NEW expression until something runs `ANALYZE` against it.
The index alone fixed the ACCESS METHOD; `ANALYZE` is what additionally
fixed the ESTIMATE. Both scripts now run `ANALYZE orders` immediately
after their `CREATE INDEX`.

### Pattern 4 fixed

Run `pnpm scenario:pattern4-fixed`:

```text
execution time: 0.083 ms      (18.167 ms -> 0.083 ms, ~219x faster)
total buffers: 20 hit / 3 read = 23 total   (2,309 -> 23, ~100x fewer)
plan: Limit -> Index Scan Backward using idx_orders_placed_at
```

No `Sort` node at all - Postgres walks the index directly in `placed_at`
order and stops after 20 rows, touching a small, roughly constant number of
pages regardless of table size.

## Why the fix works

- **Stale statistics (1a)**: `ANALYZE` samples the table and rebuilds
  `pg_statistic` - histograms, most-common-values lists, `n_distinct`. Data
  can change (a bulk `UPDATE`, a data migration, organic growth) without
  anything telling the planner; `ANALYZE` is the only thing that makes the
  planner's model catch up. Autovacuum eventually runs it automatically,
  but "eventually" is not "immediately after a bulk write."
- **Correlated columns (1b)**: Postgres's default per-column statistics
  assume every column is independent of every other column - estimating
  `P(A AND B)` as `P(A) * P(B)`. When `channel = 'phone'` is genuinely
  MORE likely given `status = 'cancelled'`, that assumption is simply
  false for this data, no matter how accurate each column's OWN statistics
  are. `CREATE STATISTICS ... (dependencies, mcv) ON status, channel FROM
  orders` tells `ANALYZE` to additionally record the JOINT distribution of
  the two columns together - `dependencies` models how strongly one column
  determines the other, `mcv` stores actual frequent (status, channel)
  COMBINATIONS directly.
- **Non-sargable function-in-WHERE (3)**: an index is sorted by whatever
  expression it indexes. A plain index on `placed_at` is sorted by the raw
  timestamp; `WHERE date_trunc('month', placed_at AT TIME ZONE 'UTC') = ?`
  needs rows sorted by the TRUNCATED value, a different sort order the raw
  index cannot provide without evaluating the function on every row
  first - which is exactly what defeats the index. Fix A indexes the exact
  expression; Fix B sidesteps the problem by rewriting the comparison as an
  equivalent range on the RAW column, which the existing plain index can
  serve directly.
- **Missing-index JOIN (2) - the buffers-up-but-faster result, explained**:
  the naive plan reads `order_lines` (601,142 rows) exactly ONCE via a
  sequential scan and hashes 2,068 filtered `orders` rows to probe against
  it - a single, cheap, entirely sequential pass, ALL of it served from
  Postgres's shared buffer cache (0 disk reads, 8,995 total cache hits).
  The fixed plan instead does 2,068 SEPARATE index lookups into
  `order_lines` via `idx_order_lines_order_id` (a Nested Loop) - more total
  buffer touches (11,327), some requiring a real disk read (925), because
  random-access index probes touch more distinct pages than one orderly
  sweep through the table. It is still 44% faster because CPU cost -
  hashing and re-scanning 601,142 rows' worth of tuples one time - is not
  free just because every page was already cached; 2,068 small, targeted
  lookups cost less CPU overall even with some real I/O mixed in. **A
  buffer count is not automatically a speed proxy** - what matters is
  whether those touches are sequential/cached or random/uncached, and how
  much CPU work happens per touch.
- **ORDER BY + LIMIT (4)**: a B-tree index is a physically sorted
  structure. `ORDER BY placed_at DESC LIMIT 20` with `idx_orders_placed_at`
  present just means "walk the index backward from its end and stop after
  20 rows" - no `Sort` node, no need to look at the other 199,875 rows at
  all. Without the index, Postgres must read every row before it can know
  which 20 are the most recent (Postgres's Top-N heapsort optimization
  still touches every row once, even though it avoids materializing a full
  sorted result).

## Tradeoffs

- **Pattern 1a's naive script permanently mutates seeded data.** Unlike
  every other pattern's naive script (which only `DROP`s/recreates
  indexes), `pattern1-bad-estimates-naive.ts` runs a real `UPDATE` that
  recategorizes up to 50,000 orders to `'cancelled'` - not reversible
  except by `pnpm seed` again. This is deliberate and mirrors a real
  incident this pattern models (a genuine bulk backend recategorization,
  not a synthetic edge case) - but it means Pattern 1b's "fixed" estimate
  is measured against a DIFFERENT, larger cancelled population than its
  own "naive" estimate was (14,089 actual phone-cancelled orders at naive
  time vs. 26,414 at fixed time) - see the code comments in both pattern1
  scripts for the exact reasoning. Reseed between full lab walkthroughs if
  you want every pattern measured against pristine data.
- **Extended statistics (1b) cost is not free, but it is a different kind
  of cost than an index's.** There is no per-write structure to maintain -
  `orders_status_channel_stats` adds essentially zero overhead to every
  `INSERT`/`UPDATE`. Its cost is entirely at `ANALYZE` time: computing the
  joint distribution of two (or more) columns is more expensive than
  computing each column's statistics independently, and that cost grows
  with the number of distinct combinations. Extended statistics do not
  scale well past a handful of columns for this reason.
- **Six of one, half dozen of the other - Fix A vs Fix B (Pattern 3).**
  Fix A (expression index) is unavoidable when no equivalent sargable
  rewrite exists (e.g. a genuinely non-invertible expression). Fix B
  (sargable rewrite) is strictly cheaper to maintain when a rewrite DOES
  exist and a suitable plain index is already justified by other queries -
  no new index, no new write-time maintenance cost, one fewer thing to keep
  correct if the underlying column's type or precision ever changes.
- **A missing-index JOIN fix does not guarantee lower total buffer usage**
  (Pattern 2, measured above: ~26% MORE total buffer touches, still ~44%
  faster). Do not use "buffers went down" as your only definition of
  success - execution time, buffer READS specifically (physical I/O, the
  expensive kind), and CPU time all matter and can move in different
  directions.
- **Write amplification, measured.** Inserting 20,000 new orders (+
  ~40,000 order_lines, ~60,000 total rows) via
  `pnpm scenario:write-amplification --count=20000`:

  | State | Total time | Throughput |
  |---|---|---|
  | Before (0 of 4 indexes) | 554 ms | 108,295 rows/sec |
  | After (4 of 4 indexes) | 614 ms | 97,787 rows/sec |

  ~11% slower wall-clock, ~10% lower throughput, for the identical insert
  workload - a smaller number than Lab 04's 6-index ~29% (fewer indexes,
  and this lab's expression/partial-style indexes are lighter than Lab 04's
  covering index), but the direction is the same: every index is
  permanent, ongoing write-time cost, paid on every future write whether
  or not that particular write ever benefits from the index existing.
- **One index serving three patterns (`idx_orders_placed_at`) is the
  argument FOR consolidation, not against it** - see "Architecture." The
  alternative (three separate, narrower indexes) would triple this
  particular index's write-amplification contribution for no read benefit
  a single well-chosen index doesn't already provide.

## Production notes

1. **What guarantee does this discipline provide?** None of these fixes
   change what a query returns - `tests/integration/query-plans.test.ts`
   asserts exactly this invariant (forcing an index and forcing a
   sequential scan for the same query must return the identical row set)
   for every index in this lab. Tuning only changes HOW Postgres finds the
   answer and HOW CONFIDENT its cost estimate is, never WHAT the answer is.
2. **What does it not guarantee?** That the planner will keep making the
   same choice forever. Data distributions drift (Pattern 1a), correlations
   can appear or disappear as a business changes (Pattern 1b), and a join's
   selectivity at one data volume does not predict its selectivity at
   another (Pattern 2's own README numbers needed a 7-day window, not 30,
   to show a join-strategy change at all - see `sample-window.ts`).
   Retune, don't "fix once and forget."
3. **What breaks under process crash?** Not applicable to read-only tuning
   work directly, but `ANALYZE` and `CREATE STATISTICS` are both
   transactional DDL/maintenance commands - a crash mid-`ANALYZE` leaves
   the previous statistics in place (never partially-updated), the same
   safety property Postgres gives every other DDL statement in this
   repository's labs.
4. **What breaks under network partition / replica lag?** Not applicable -
   single Postgres node, no replicas (see Lab 24+). Note for later,
   though: statistics themselves replicate via WAL just like any other
   catalog change, so a stale-statistics problem observed on a REPLICA
   could reflect either genuinely stale statistics OR simple replication
   lag - check `pg_stat_replication` before assuming it's a statistics
   problem.
5. **What changes at high contention?** `ANALYZE` takes only a
   `ShareUpdateExclusiveLock` (does not block reads or writes, only
   conflicts with other DDL/`VACUUM`/`ANALYZE` on the same table) - safe to
   run against a live, busy table. `CREATE STATISTICS` itself is cheap
   (just registers a catalog entry); the actual computation happens at the
   next `ANALYZE`, which has the same locking behavior.
6. **What changes at larger scale?** Every number in this README is
   dataset-shape-dependent - see Pattern 2's window-size sensitivity above
   and the "Further experiments" section. Re-measure at your actual
   production data volume and distribution; do not assume this lab's exact
   thresholds (e.g. "7 days vs 30 days changes the join strategy") transfer
   to a different table.
7. **What metrics would be monitored?** `pg_stat_user_tables.last_analyze`/
   `last_autoanalyze` (is this table's statistics fresh?),
   `pg_stat_statements` (real query latency distributions and how they
   drift over time), `pg_stat_user_indexes` (is a given index actually
   being scanned?), and application-level p99 latency for the specific
   query shapes this lab covers.
8. **What simpler alternative could be used?** For Pattern 1's estimate
   problems: sometimes just running `ANALYZE` manually after a known bulk
   data event is enough - you don't always need `CREATE STATISTICS`, only
   when the columns are GENUINELY correlated (verify with real counts, as
   this lab's scenario scripts do, not just intuition). For Pattern 3:
   always prefer a sargable rewrite over a new expression index when one
   exists.
9. **When should this discipline be avoided?** Don't chase `EXPLAIN`
   numbers on a table small enough that the difference is noise (see Lab
   04's own tests, where a 200-600 row test table correctly plans as a
   sequential scan regardless of which indexes exist) - tuning effort
   belongs on tables and queries where the real, measured cost matters.

## Interview questions

1. Two row-estimate problems look identical from the application's point
   of view (a slow query, `EXPLAIN` shows `Plan Rows` far from `Actual
   Rows`) but need completely different fixes. What are they, how do you
   tell them apart from `EXPLAIN` output alone, and why doesn't the wrong
   fix (e.g. `ANALYZE` for a correlation problem) help at all?
2. Why does Postgres refuse to build an index on
   `date_trunc('month', a_timestamptz_column)` directly, and what is the
   general rule (IMMUTABLE vs STABLE vs VOLATILE) behind that refusal?
3. A query has a covering index available and the planner ignores it,
   preferring a full scan. Walk through at least two structurally different
   reasons that could be correct planner behavior, not a bug.
4. You add an index intended to speed up a JOIN, rerun `EXPLAIN ANALYZE`,
   and the total buffer count went UP even though the query got faster.
   Is this evidence the index is wrong? Justify your answer with the
   sequential-vs-random-I/O reasoning this lab measured directly.
5. Why is `CREATE STATISTICS` not a replacement for `ANALYZE`, and why is
   `ANALYZE` not a replacement for `CREATE STATISTICS`, in the specific
   case of two correlated columns?
6. Given a sargable rewrite AND an expression index both fix the same
   non-sargable query, what's your decision procedure for choosing between
   them?
7. Design question: a table has a JOIN query whose selectivity varies
   wildly by time window - narrower windows favor a Nested Loop + index,
   wider windows favor a Hash Join + full scan, and neither is "wrong" for
   its own cardinality. What would you actually do about this in
   production, if anything?
8. What is the difference between a `Shared Hit Block` and a `Shared Read
   Block` in `EXPLAIN (ANALYZE, BUFFERS)` output, and why does that
   distinction matter more than the raw total when judging a plan?

## Further experiments

- Change Pattern 1a's `--count=` argument (default 50,000) to a much
  smaller number and see how small a recategorization batch still produces
  a measurably wrong stale estimate on this dataset - is there a threshold
  below which `ANALYZE`'s own sampling just doesn't notice?
- Widen or narrow Pattern 2's join window (`pickMiddleWeekWindow` in
  `src/scenarios/sample-window.ts`) and find the exact matching-order-count
  threshold where the planner stops choosing a Nested Loop for
  `order_lines` - this lab's own README numbers were captured at a 7-day
  window (~2,068 matching orders); 30 days (~9,000 matching orders) never
  changes the `order_lines` join strategy at all.
- Run `EXPLAIN (ANALYZE, BUFFERS)` (text format, not JSON) by hand for one
  of this lab's queries and manually verify the cumulative-buffers claim
  this README makes - confirm a parent node's `Buffers:` line is within a
  few pages of its child's, not the sum of the whole subtree.
- Drop `orders_status_channel_stats` and rerun Pattern 1b's fixed query
  with only `dependencies` (no `mcv`), then only `mcv` (no `dependencies`)
  - compare which one alone gets closer to the real estimate for THIS
  specific correlation shape.
- Seed with `--rows=2000000` (or a custom `--seed=`) and rerun every
  pattern's naive/fixed pair - do the relative speedups grow, shrink, or
  stay roughly the same as the table gets bigger? Does Pattern 2's
  join-strategy threshold (in matching-order count) change?
