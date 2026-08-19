# Lab 04 - Indexes and Performance Basics

## Why this exists

Lab 03 ended with a warning: every query in that lab plans as a sequential
scan, because the schema has no indexes beyond what `PRIMARY KEY`/`UNIQUE`
force automatically. On Lab 03's small dataset (a few hundred customers,
a few thousand orders) that's invisible - a sequential scan over 2,700 rows
takes a fraction of a millisecond either way. This lab exists to make it
visible: seed the same commerce schema to over a million rows, run the
exact query shapes a real application would run ("orders for this
customer", "line items for this order", "pending orders older than X"),
and watch Postgres spend real, measurable milliseconds walking the entire
table for each one. Then add the right indexes and watch the same queries
answer in fractions of a millisecond - and watch plain `INSERT`s get
measurably slower, because an index is not a free lunch: every index on a
table is more work every writer has to do, forever, to keep that index
correct.

## Learning objectives

After this lab you should be able to:

- read `EXPLAIN ANALYZE` output well enough to tell a `Seq Scan` from an
  `Index Scan`, an `Index Only Scan`, and a `Bitmap Heap Scan` /
  `Bitmap Index Scan`, and explain what each one is doing differently;
- explain why a composite index `(a, b)` can serve an equality filter on
  `a` *and* a sort on `b` in one index, without a separate `Sort` step;
- explain what a partial index (`CREATE INDEX ... WHERE ...`) buys you over
  a full index when the filtered condition is a small minority of the
  table, and why Postgres does not need to re-check that condition once
  it's already implied by the index;
- explain what a covering index (`INCLUDE (...)`) buys you - an
  `Index Only Scan` that never touches the table heap at all - and why that
  additionally depends on the visibility map (`VACUUM`), not just the index
  existing;
- explain why an expression index (`lower(email)`) is required for
  Postgres to use an index at all when the query applies a function to the
  column, and why a plain index on `email` cannot help a
  `WHERE lower(email) = ...` query;
- explain index selectivity concretely: given the *actual* measured
  distribution of a column in this lab's own data, predict (and then
  verify) which values Postgres's planner will use an index for and which
  values it will ignore the index for, in favor of a sequential scan;
- explain write amplification concretely, with a real measured number: how
  much slower a fixed batch of `INSERT`s becomes once the table has several
  indexes on it, in this lab's own data.

## Architecture

```text
customers ──1:N── orders ──1:N── order_lines ──N:1── products
```

Domain: **commerce**, reused byte-for-byte in shape from Lab 03
(`customers`, `products`, `orders`, `order_lines` - see
`packages/data-generators/src/commerce.ts`). This lab does not introduce a
new domain; it introduces *scale* and *indexes* on top of the exact schema
Lab 03 already taught you to query.

Two migrations, on purpose:

```text
drizzle/0000_graceful_stryfe.sql        <- base tables (same shape as Lab 03), no indexes
drizzle/0001_add_performance_indexes.sql <- 6 performance indexes, hand-written raw SQL
```

`0001` is a **hand-written custom migration**
(`drizzle-kit generate --custom`), not one produced by diffing
`src/db/schema.ts`. Partial indexes (`WHERE`), covering indexes
(`INCLUDE`), and expression indexes (`lower(email)`) have inconsistent
support across drizzle-kit versions - per `CLAUDE.md`'s "ORM plus SQL"
principle, raw SQL is the clearer and more honest tool for exactly this
kind of Postgres-specific feature. `src/db/schema.ts` does **not** declare
these indexes as Drizzle `index()` builders at all; Postgres uses them
transparently regardless of whether the TypeScript schema object "knows"
about them. See that file's header comment and "Why the fix works" below.

**On `CREATE INDEX` vs `CREATE INDEX CONCURRENTLY`**: this lab's migration
uses plain `CREATE INDEX`, deliberately. A plain `CREATE INDEX` takes a
`SHARE` lock on the table for the duration of the build - reads are still
allowed, but every `INSERT`/`UPDATE`/`DELETE` blocks until the index
finishes. On a table with production write traffic, that's a real outage
risk and `CREATE INDEX CONCURRENTLY` (which avoids the blocking lock, at
the cost of a slower, non-transactional build) is the correct tool - that
nuance, and migration safety in general, is Lab 29's dedicated topic. This
lab is a local, single-node database with no concurrent traffic to
protect, and `CREATE INDEX CONCURRENTLY` cannot run inside the transaction
block Drizzle's migrator wraps each migration in anyway. **Do not copy
plain `CREATE INDEX` onto a production table without reading Lab 29
first.**

The 6 indexes (single source of truth: `src/scenarios/index-definitions.ts`,
mirrored in `drizzle/0001_add_performance_indexes.sql`):

| # | Index | Type | Target query |
|---|-------|------|---------------|
| 1 | `idx_order_lines_order_id` | plain B-tree | order_lines for an order |
| 2 | `idx_orders_customer_id_placed_at` | composite | recent orders for a customer |
| 3 | `idx_orders_pending_placed_at` | partial (`WHERE status='pending'`) | pending-orders ops queue |
| 4 | `idx_order_lines_product_id_covering` | covering (`INCLUDE`) | quantity/price for a product, index-only |
| 5 | `idx_customers_lower_email` | expression (`lower(email)`) | case-insensitive email lookup |
| 6 | `idx_orders_status` | plain B-tree, low selectivity | selectivity demonstration |

## Setup

```bash
pnpm install
cp labs/04-indexes-and-performance-basics/.env.example labs/04-indexes-and-performance-basics/.env
cd labs/04-indexes-and-performance-basics
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate    # applies BOTH migrations (base tables + performance indexes)
pnpm seed --size=small   # fast sanity check: ~300 customers, ~3.6k orders+lines, well under a second
```

Open PGweb at http://localhost:8404 (auto-connects via `PGWEB_DATABASE_URL`).

**The real experiment needs a much larger dataset - budget real time for
this.** On this machine, `pnpm seed --seed=42 --size=large` generated
60,000 customers, 500 products, 300,424 orders, and 902,682 order_lines
(1,203,106 combined orders+order_lines rows - comfortably over the 1M+
SPEC.md target) in **~37 seconds** (~32,600 rows/sec), streaming/batching
inserts the whole way rather than holding a million objects in memory (see
"Data Generation" below). This is **not** a default a learner should run
by accident - it is a deliberate, ~30-60 second step:

```bash
pnpm seed --seed=42 --size=large
# or, to target an approximate row count directly instead of a size preset:
pnpm seed --seed=42 --rows=1000000
```

## Scenario

The same small commerce business from Lab 03 has grown. It now has 60,000
customers and hundreds of thousands of orders. Its application runs the
same handful of query shapes constantly:

- "Show this customer their 10 most recent orders."
- "Show me the line items for this order." (order confirmation page)
- "Show ops the oldest pending orders from the last year." (fulfillment queue)
- "How many units of this product have sold, and for how much?" (per-product reporting)
- "Look this customer up by email." (support tool, case-insensitive)

Every one of these is a `WHERE`/`ORDER BY` on a column with **no**
supporting index - the schema is exactly Lab 03's, and Lab 03 deliberately
shipped with none. At Lab 03's scale that didn't matter. At this lab's
scale, it does.

## Prediction

Before running anything, predict:

1. `orders.customer_id` is a foreign key with no index on it (yet). For
   "this customer's 10 most recent orders" on a ~300k-row `orders` table,
   will Postgres use `orders_customer_id_customers_id_fk` (a nonexistent
   index - foreign keys do NOT automatically get an index in Postgres) or
   scan the whole table?
2. Once `idx_orders_status` exists, will Postgres use it for
   `WHERE status = 'paid'` (the majority status, ~58% of rows) the same
   way it uses it for `WHERE status = 'cancelled'` (~8% of rows)? Why or
   why not?
3. Once `idx_order_lines_product_id_covering` exists (`INCLUDE (quantity,
   unit_price_cents)`), will `SELECT quantity, unit_price_cents FROM
   order_lines WHERE product_id = ?` need to touch the `order_lines` table
   heap at all?
4. Will a fixed batch of 20,000 new orders (+ ~40,000 order_lines) insert
   faster or slower once these 6 indexes exist? By roughly how much?

## Exercise

1. Run the setup commands above, including `pnpm seed --seed=42
   --size=large`.
2. Run the "before" scenario - this **drops** all 6 performance indexes
   first (so it's honest even if you already ran `db:migrate`), then runs
   6 representative queries with real `EXPLAIN ANALYZE`:
   ```bash
   pnpm scenario:before-indexing
   ```
3. Run the "after" scenario - this **(re)creates** all 6 indexes, then
   reruns the exact same 6 queries, plus the selectivity demonstration
   (predictions #2 and #3, for real):
   ```bash
   pnpm scenario:after-indexing
   ```
4. Run the write-amplification scenario once right after step 2 (indexes
   absent) and once right after step 3 (indexes present) - it detects
   which state the database is in from `pg_indexes` and labels its own
   output `"before"`/`"after"` accordingly (prediction #4, for real):
   ```bash
   pnpm scenario:write-amplification --count=20000
   ```

## Observe

- **PGweb** (http://localhost:8404): the "Indexes" tab on `orders` and
  `order_lines` after step 3 - six new indexes, sizes visible.
- **Real captured output from this exact lab** (seed 42, `--size=large`,
  ~1.2M orders+order_lines rows) - see "Break it" / "Fix it" below for the
  full before/after comparison.
- **`SET enable_seqscan = off` / `enable_indexscan = off` /
  `enable_bitmapscan = off`**: this lab's own tests
  (`tests/integration/plans.test.ts`) use these session-level planner GUCs
  to force Postgres toward or away from an index deterministically,
  regardless of table size - genuinely useful in production too, when you
  want to know "would Postgres even consider using this index if I forced
  it to?" without waiting for the planner to naturally prefer it.
- **`pg_indexes`**: `SELECT indexname, tablename FROM pg_indexes WHERE
  schemaname = 'public'` (or run `pnpm dev`) to see exactly which indexes
  exist right now.
- **Structured logs**: every script here logs through `@labs/logging`
  (Pino), including the full parsed `EXPLAIN ANALYZE` plan and a parsed
  summary (`hasSeqScan`, `hasIndexScan`, `hasIndexOnlyScan`,
  `hasBitmapScan`, `executionTimeMs`) per query.

## Break it

Run:

```bash
pnpm scenario:before-indexing
```

Real output from this lab's own validation run (seed 42, `--size=large`:
60,000 customers, 500 products, 300,424 orders, 902,682 order_lines):

| Query | Plan | Execution Time |
|---|---|---|
| Q1 recent orders for a customer | `Parallel Seq Scan on orders` | 5.380 ms |
| Q2 order_lines for an order | `Parallel Seq Scan on order_lines` | 10.618 ms |
| Q3 pending orders ops queue | `Parallel Seq Scan on orders` | 8.337 ms |
| Q4 quantity/price for a product | `Parallel Seq Scan on order_lines` | 10.884 ms |
| Q5 case-insensitive email lookup | `Seq Scan on customers` | 13.488 ms |
| Q6 product lookup by SKU (baseline) | `Index Scan using products_sku_unique` | 0.025 ms |

Every query that needed one of this lab's 6 new indexes got a sequential
scan (Postgres even parallelized several of them across 2 worker
processes - still a full scan, just a faster full scan). Q6 is the
deliberate control: `products.sku` already has a `UNIQUE` constraint from
Lab 03's migration, which Postgres backs with a B-tree index automatically
- so Q6 was already fast, *before this lab added anything*. That's the
whole point of Q6: `PRIMARY KEY`/`UNIQUE` already give you an index for
free; foreign key columns and arbitrary `WHERE`/`ORDER BY` columns do not.

## Fix it

Run:

```bash
pnpm scenario:after-indexing
```

Real output, same dataset, same 6 queries, indexes now present:

| Query | Plan | Execution Time | Speedup |
|---|---|---|---|
| Q1 recent orders for a customer | `Index Scan Backward using idx_orders_customer_id_placed_at` | 0.025 ms | ~215x |
| Q2 order_lines for an order | `Index Scan using idx_order_lines_order_id` | 0.019 ms | ~559x |
| Q3 pending orders ops queue | `Index Scan Backward using idx_orders_pending_placed_at` | 0.191 ms | ~44x |
| Q4 quantity/price for a product | `Index Only Scan using idx_order_lines_product_id_covering` (`Heap Fetches: 0`) | 0.223 ms | ~49x |
| Q5 case-insensitive email lookup | `Bitmap Heap Scan` via `idx_customers_lower_email` | 0.030 ms | ~450x |
| Q6 product lookup by SKU (baseline) | `Index Scan using products_sku_unique` | 0.018 ms | unchanged |

Q4's plan line literally says `Heap Fetches: 0` - Postgres answered the
query entirely from the index, never touching the `order_lines` table
itself. Q6 is unchanged, as expected - this migration didn't touch
`products` at all.

**Selectivity, measured, not assumed.** `after-indexing.ts` also measures
the actual distribution of `orders.status` in this dataset and runs the
same equality filter against both a common value and a rare one:

```text
paidFraction: 0.578        (57.8% of all orders)
cancelledFraction: 0.075   (7.5% of all orders)

WHERE status = 'paid'      -> Seq Scan on orders            -> 20.706 ms  (index IGNORED)
WHERE status = 'cancelled' -> Bitmap Heap Scan on orders     ->  5.119 ms  (index USED)
```

`idx_orders_status` exists in both cases. Postgres's planner estimates
that for `'paid'` (185,361 of ~320k rows), reading the whole table
sequentially is cheaper than following 185,361 index entries back to the
heap one at a time - the index would cost *more* than not using it. For
`'cancelled'` (24,107 rows, ~7.5%), the index wins. **An index existing
does not mean Postgres will use it** - low selectivity is a real, common
reason a "missing index" complaint turns out not to be one.

**Write amplification, measured.** Inserting the same 20,000 new orders
(+ their order_lines - 59,999 total rows) via `pnpm scenario:write-amplification
--count=20000`:

| State | Total time | Throughput |
|---|---|---|
| Before (0 of 6 indexes) | 555 ms | 108,095 rows/sec |
| After (6 of 6 indexes) | 784 ms | 76,542 rows/sec |

That's roughly **41% slower** wall-clock, ~29% lower throughput, for the
exact same insert workload - purely from index maintenance. Six indexes on
two tables is not an extreme case; this is what "indexes aren't free"
looks like with real numbers, not a hand-wave.

**Index build cost, measured.** Building all 6 indexes over the ~1.2M-row
dataset from a cold page cache took well under a second combined (117 ms +
66 ms + 18 ms + 237 ms + 52 ms + 83 ms in this lab's own validation run -
the covering index, which has to include two extra columns' worth of data
per entry, was the most expensive of the six). On a much larger production
table this cost - and the `SHARE` lock held for its duration - is exactly
why Lab 29 exists.

## Why the fix works

An index is a separate, sorted (B-tree, for everything in this lab) data
structure that lets Postgres jump directly to matching rows instead of
reading every row in the table to find them. Concretely, for each index
here:

- **Plain B-tree** (`idx_order_lines_order_id`): `order_id` values are
  stored in sorted order with pointers back to their heap rows, so
  "find rows where order_id = X" is an `O(log n)` tree descent instead of
  an `O(n)` scan.
- **Composite** (`idx_orders_customer_id_placed_at`): a B-tree on
  `(customer_id, placed_at)` is physically sorted first by `customer_id`,
  then by `placed_at` within each `customer_id`. That means "all of
  customer X's orders, in `placed_at` order" is already contiguous and
  pre-sorted in the index - no separate `Sort` step needed (see
  `Index Scan Backward` in Q1's plan above: Postgres just walks the index
  in reverse instead of sorting).
- **Partial** (`idx_orders_pending_placed_at`): the index only contains
  entries for rows where `status = 'pending'` - about 12% of the table by
  generator design (see `STATUS_WEIGHTS` in `commerce.ts`). A smaller
  index means less disk, less cache pressure, and critically, **less
  maintenance work on every INSERT/UPDATE that isn't 'pending'** - a write
  to a `'paid'` order never touches this index at all.
- **Covering / `INCLUDE`** (`idx_order_lines_product_id_covering`): the
  index stores `quantity` and `unit_price_cents` alongside the indexed
  `product_id`, even though they're not part of the sort key. A query that
  only needs those columns can be answered by reading the index alone -
  an **Index Only Scan** - provided the visibility map says the relevant
  heap pages are all-visible (this lab's scripts run `VACUUM ANALYZE`
  before this query for exactly that reason; skip it and you may see a
  plain `Index Scan` instead, with real heap fetches, even though the
  index itself is fine).
- **Expression** (`idx_customers_lower_email`): a plain index on `email`
  is sorted by the raw `email` value. `WHERE lower(email) = 'x'` needs
  rows sorted by `lower(email)`, which is a different sort order - a plain
  index cannot help at all (Postgres cannot know two different strings
  lowercase to the same value without evaluating the function). Indexing
  `lower(email)` directly gives the planner exactly the sort order the
  query needs.
- **Selectivity** (`idx_orders_status`): an index only pays off when
  following it is cheaper than reading the table directly - which mostly
  means "when it eliminates most of the rows." A column with only 4
  distinct values, one of which is the majority, is a textbook
  low-selectivity case for that majority value.

## Tradeoffs

- **Six indexes on two tables is already meaningful write overhead**
  (measured above: ~29% lower insert throughput) - every additional index
  is additional work on every `INSERT`/`UPDATE`/`DELETE` that touches an
  indexed column, forever, whether or not that particular write ever
  benefits from the index existing. Index for the queries you actually
  run, not defensively.
- **Partial vs full index**: `idx_orders_pending_placed_at` only helps the
  pending-orders query. A full index on `(status, placed_at)` would also
  serve other statuses, at the cost of indexing 100% of rows instead of
  ~12% - more disk, more maintenance, for query patterns this lab doesn't
  actually have. Prefer partial when a query pattern only ever touches a
  known minority slice of a column's values.
- **Covering index size**: `INCLUDE`-ing columns makes every index entry
  bigger (more disk, slower index-only scan when many rows match), in
  exchange for potentially skipping the heap entirely. It's a good trade
  when the included columns are small and the query is hot; it's a bad
  trade for "just in case" columns nobody actually selects.
- **Plain `CREATE INDEX` vs `CONCURRENTLY`**: see "Architecture" above -
  this lab took the simpler, blocking option deliberately, and that choice
  would be wrong on a live production table.
- **Composite column order matters**: `(customer_id, placed_at)` serves
  "orders for a customer, sorted by date" and "orders for a customer"
  alone (leftmost-prefix rule), but does **not** serve "orders placed
  after date X, across all customers" - that would need `placed_at` as the
  leading column instead. Index column order should match your actual
  query shape, not be chosen arbitrarily.

## Production notes

1. **What guarantee does this technique provide?** None of these indexes
   change what a query returns - `tests/integration/plans.test.ts` asserts
   exactly this invariant (forcing an index scan and forcing a sequential
   scan for the same query must return the identical row set) for every
   index in this lab. Indexes only change *how* Postgres finds the answer,
   never *what* the answer is.
2. **What does it not guarantee?** That the planner will use the index.
   Selectivity, table size, and up-to-date statistics (`ANALYZE`) all
   factor into the planner's cost estimate - an index that exists is not
   an index that gets used (see the `status = 'paid'` result above).
3. **What breaks under process crash?** Index builds in this lab are
   non-concurrent and run inside Drizzle's migration transaction - a crash
   mid-build rolls the whole `CREATE INDEX` back, leaving no partial index
   behind. (`CREATE INDEX CONCURRENTLY`, used in production, behaves
   differently - a crash mid-build can leave an `INVALID` index that must
   be dropped and retried. See Lab 29.)
4. **What breaks under network partition?** Not applicable - single
   Postgres node, no replicas yet (see Lab 24+).
5. **What changes at high contention?** Every index adds lock/maintenance
   overhead to every write that touches an indexed column - under high
   write concurrency, that overhead compounds across concurrent
   transactions, not just within one (write-amplification numbers above
   are single-threaded; multi-writer contention makes the relative cost of
   extra indexes worse, not better).
6. **What changes with multiple regions?** Not applicable yet - but note
   that every index is *also* extra WAL volume per write, which directly
   affects replication lag once replicas exist (Lab 24+/26).
7. **What metrics would you monitor?** `pg_stat_user_indexes` (index scan
   counts - an index with zero scans over time is a maintenance-only cost
   with no benefit and a candidate for removal), `pg_stat_user_tables`
   (sequential scan counts and rows read per scan - a growing "seq scans on
   a huge table" number is exactly the signal that started this lab), and
   `pg_stat_statements` for real query latency distributions in
   production.
8. **What simpler alternative could be used?** Sometimes: none needed at
   all. A table under some threshold (a few hundred to a few thousand rows,
   roughly - see this lab's own tests, where the planner correctly prefers
   a sequential scan over an index on a 200-row test table) doesn't benefit
   from indexing; adding one anyway is pure write overhead for no read
   benefit.
9. **When should you avoid this technique?** Avoid indexing a column just
   because it appears in a `WHERE` clause somewhere - check the column's
   actual selectivity and the table's actual size first (`EXPLAIN
   ANALYZE`, `pg_stats.n_distinct`). Avoid `INCLUDE`-ing wide or rarely-
   selected columns "just in case." Avoid plain `CREATE INDEX` on a live,
   write-heavy production table (see Lab 29).

## Interview questions

1. A foreign key column has no supporting index by default in Postgres.
   What specifically goes wrong (and how badly) as a table with that
   foreign key grows, and why doesn't Postgres just create one
   automatically the way it does for `PRIMARY KEY`/`UNIQUE`?
2. Given a composite index on `(a, b)`, which of these can it serve
   without a full scan: `WHERE a = ?`, `WHERE b = ?`, `WHERE a = ? AND b =
   ?`, `WHERE a = ? ORDER BY b`? Explain the leftmost-prefix rule.
3. Why does Postgres sometimes ignore an index that objectively exists and
   covers the query's `WHERE` clause? Walk through the cost trade-off in
   your own words.
4. What does `Heap Fetches: 0` in an `Index Only Scan` plan tell you, and
   what would cause `Heap Fetches` to be nonzero even with a covering
   index in place?
5. Why can't a plain index on `email` serve `WHERE lower(email) = ?`, and
   what's the fix?
6. You're told "we added an index and writes got slower, but that query is
   still slow too - what happened?" What two things would you check first?
7. Why does this lab's migration use plain `CREATE INDEX` instead of
   `CREATE INDEX CONCURRENTLY`, and under what circumstances would that be
   the wrong call?
8. Design question: you have a `status` column with 4 possible values,
   heavily skewed (one value is 80% of rows). A support tool needs fast
   lookups by the rare values only. What index would you build, and why
   not just index the whole column?

## Further experiments

- Drop `idx_orders_customer_id_placed_at` and add a plain index on
  `customer_id` alone instead - rerun Q1's `EXPLAIN ANALYZE` and compare:
  does the plan still avoid a separate `Sort` step?
- Run `ANALYZE orders;` then check `pg_stats` for `status`'s
  `most_common_vals`/`most_common_freqs` - compare against the
  `paidFraction`/`cancelledFraction` this lab measured directly by
  counting.
- Seed with `--rows=2000000` (or higher) and rerun both scenario scripts -
  do the *relative* speedups (before vs after) grow, shrink, or stay
  roughly the same as the table gets bigger? Why?
- Change the covering index to a plain (non-`INCLUDE`) index on
  `order_lines(product_id)` and rerun Q4 - confirm the plan changes from
  `Index Only Scan` to a plain `Index Scan` with nonzero heap fetches.
- Comment out the `VACUUM ANALYZE order_lines` call in
  `after-indexing.ts` right after seeding a *fresh* large dataset (before
  autovacuum has had a chance to run) and see whether Q4 still reports
  `Index Only Scan` - this is the visibility-map gotcha called out in "Why
  the fix works."
- Run `pnpm scenario:write-amplification --count=100000` (a much bigger
  batch) before and after indexing and see whether the *relative*
  slowdown from indexes holds steady, grows, or shrinks at higher write
  volume.
