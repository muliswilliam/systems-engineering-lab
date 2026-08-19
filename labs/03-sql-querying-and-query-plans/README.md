# Lab 03 - SQL Querying and Query Plans

## Why this exists

Every lab from here on assumes you can read and write real SQL fluently -
joins across three or four tables, an aggregation that needs a GROUP BY, a
report that needs two chained CTEs, a leaderboard that needs a window
function - and that you can look at `EXPLAIN` output and know roughly what
Postgres is about to do. If SQL itself is the bottleneck, every later lab
(locks, isolation levels, replication, indexing) becomes twice as hard to
follow, because you're learning the concept and the query language at the
same time. This lab exists to make SQL itself a non-issue before Lab 04
starts asking "is this fast?" - a question that only makes sense once you
can already answer "what does this query even do?"

This lab also exists to teach one very specific, very common bug: joining a
one-to-many relationship and then counting across the join. It looks
correct, it runs without error, and the revenue number next to the broken
count is completely accurate - which is exactly why it ships to production
undetected. See "Break it" / "Fix it" below.

## Learning objectives

After this lab you should be able to:

- write an inner join across three or four tables and a left join to find
  "the parent with no matching child", in both Drizzle and raw SQL;
- write a GROUP BY aggregation and know when you need `count(DISTINCT ...)`
  instead of `count(...)`;
- write a multi-step report as two chained CTEs instead of one dense nested
  query, and know why "aggregate the child table first, then join" is a
  general technique, not a one-off trick;
- write a window function (`SUM(...) OVER (PARTITION BY ... ORDER BY ...)`,
  `RANK() OVER (ORDER BY ...)`) and explain why Drizzle's query builder has
  no first-class support for it;
- write a scalar subquery in a `WHERE` clause and a `NOT EXISTS` anti-join,
  and explain why `NOT EXISTS` is generally safer than `NOT IN` against a
  subquery that might contain a NULL;
- read `EXPLAIN` output well enough to identify a sequential scan, a hash
  join, and a hash aggregate, and read `EXPLAIN ANALYZE` well enough to
  compare Postgres's row-count estimate against what actually happened;
- explain, with a real example, how a join across a one-to-many relationship
  can silently inflate a `COUNT`, why the accompanying `SUM` is unaffected,
  and how pre-aggregating in a CTE before joining fixes it in general (not
  just for this one query).

## Architecture

```text
customers ──1:N── orders ──1:N── order_lines ──N:1── products
    │                 │                              │
    └── some have     └── status: pending/paid/       └── ~20% of the
        zero orders       shipped/cancelled               catalog is
        (LEFT JOIN            (WHERE / subqueries)         never ordered
        exercise)                                          (NOT EXISTS
                                                             exercise)
```

Domain: **commerce** (customers, products, orders, order_lines) - chosen
over Lab 01/02's payroll domain because it naturally produces a genuine
multi-level, one-to-many-to-many join (customer → orders → order_lines →
products). That shape is exactly what makes joins, aggregations, CTEs, and
window functions all meaningful at once, and it is exactly the shape that
produces the join-fan-out bug this lab's "Break it" / "Fix it" is built
around. `order_lines.unit_price_cents` is a **snapshot** of the product's
price at order time (not a live reference to `products.unit_price_cents`),
the way a real checkout freezes the price a customer agreed to pay.

No indexes exist anywhere in this schema beyond what `PRIMARY KEY` and
`UNIQUE` constraints force automatically. That is deliberate - every query
in this lab plans as a sequential scan, and index tuning is entirely
out of scope here (see Lab 04).

## Setup

```bash
pnpm install
cp labs/03-sql-querying-and-query-plans/.env.example labs/03-sql-querying-and-query-plans/.env
cd labs/03-sql-querying-and-query-plans
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate
pnpm seed
```

Open PGweb at http://localhost:8403 (it auto-connects via
`PGWEB_DATABASE_URL`). You should see `customers`, `products`, `orders`, and
`order_lines` populated - with `pnpm seed`'s default `--size=small`, that's
300 customers, 80 products, 909 orders, and 2,726 order lines.

## Scenario

A small commerce business sells products to customers. Every order has one
or more order lines, each referencing a product at the price it had when
the order was placed. Some customers have never ordered anything (the seed
generator leaves ~1/7 of customers order-less on purpose), and about 20% of
the product catalog has never been ordered (a deliberate long tail of
dead stock/new arrivals). The business wants answers to ordinary reporting
questions:

- Which products did a given order contain, and who ordered them?
- Which customers have never placed an order?
- How much revenue came from each product category?
- Who are the top 10 customers by total spend, and what's each customer's
  running revenue total over time?
- Which customers spend more than the average customer? Which products have
  never sold?

Every one of those questions is one of this lab's demo scripts.

## Prediction

Before running anything, predict:

1. With no indexes anywhere except what `PRIMARY KEY`/`UNIQUE` force, will
   `EXPLAIN` on a query that joins `customers`, `orders`, and `order_lines`
   show a `Seq Scan`, an `Index Scan`, or something else, on each table?
2. If you write `SELECT c.id, count(o.id) AS order_count FROM customers c
   JOIN orders o ON o.customer_id = c.id JOIN order_lines ol ON
   ol.order_id = o.id GROUP BY c.id` for a customer with exactly 2 orders,
   one with 3 lines and one with 1 line, what number does `order_count`
   report - `2`, `4`, or something else?
3. Does `sum(order_lines.line_total_cents)` in that same query still report
   the customer's correct total revenue, or is it wrong for the same reason
   the count is wrong?

## Exercise

1. Run the setup commands above.
2. Run every topic demo and read the log output - each one runs the same
   query through the Drizzle query builder and through raw SQL, and reports
   whether they agree:
   ```bash
   pnpm demo:joins
   pnpm demo:aggregations
   pnpm demo:ctes
   pnpm demo:window-functions
   pnpm demo:subqueries
   ```
3. Run `pnpm demo:explain` and read the `EXPLAIN` / `EXPLAIN ANALYZE` output
   - this is prediction #1, for real.
4. Run `pnpm scenario:naive` and `pnpm scenario:fixed` - this is predictions
   #2 and #3, for real. See "Break it" / "Fix it" below.

## Observe

- **PGweb** (http://localhost:8403): browse `orders` and `order_lines` for a
  single order with more than one line - this is the row shape behind the
  fan-out bug.
- **`docker compose logs postgres`**: the raw SQL every script sends
  (`log_statement=all` is on), useful for comparing against the "raw SQL"
  half of each demo script.
- **`psql "$DATABASE_URL" -c 'EXPLAIN SELECT ...'`**: run any query from
  `src/scenarios/*.ts` by hand and read the plan yourself.
- **bigint vs number**: run `pnpm demo:joins` or `pnpm demo:aggregations`
  and compare the JSON shape of the Drizzle output against the raw SQL
  output for any `bigint` column (e.g. `customerId`). Drizzle's
  `bigint(..., { mode: "number" })` decodes it as a JS `number`; raw
  `pg.Pool.query` returns Postgres `bigint` (`int8`) columns as a **string**,
  because `node-postgres` refuses to silently narrow a 64-bit integer into a
  JS `number` (which only safely represents up to 2^53). This lab's own
  `src/scenarios/naive-report.ts` originally shipped a real bug caused by
  exactly this: a `Map<number, number>` built from a raw SQL result was
  keyed by the string `"786"`, and every lookup with the plain number `786`
  silently missed and fell back to a default of `0`. The fix - casting
  `customer_id::int` in the raw SQL and wrapping in `Number(...)` - is still
  in the file, with a comment explaining why.
- **Structured logs**: every script here logs through `@labs/logging`
  (Pino) with a `name` field per script (`lab03:demo:joins`,
  `lab03:scenario:fixed`, etc.).

## Break it

Run:

```bash
pnpm scenario:naive
```

This report joins `customers` → `orders` → `order_lines` (it needs the join
to reach `line_total_cents` for the revenue figure) and then computes
`count(orders.id)` per customer. Real output from this lab's seed data
(`--seed=42 --size=small`):

```json
{"customerName":"Ward Brown","reportedOrderCount":20,"actualOrderCount":6,"inflated":true,"revenueCents":"1958607"}
{"customerName":"Bertha Gerhold","reportedOrderCount":15,"actualOrderCount":4,"inflated":true,"revenueCents":"1256380"}
{"customerName":"Johnpaul Schmeler","reportedOrderCount":16,"actualOrderCount":5,"inflated":true,"revenueCents":"1214529"}
```

Ward Brown has 6 real orders, but the naive query reports 20. The join to
`order_lines` fans each order out into one row per line it has - an order
with 4 lines contributes 4 identical `orders.id` values to the joined result
set - and `count(orders.id)` counts *rows in the joined result*, not
distinct orders. `revenueCents` is correct: `sum(line_total_cents)` adds
each line's own total exactly once, so the fan-out doesn't affect it at all.
That's what makes this bug dangerous - the number everyone actually checks
(revenue) is right, so the number sitting right next to it (order count)
never gets a second look.

## Fix it

Run:

```bash
pnpm scenario:fixed
```

The corrected query pre-aggregates `order_lines` into one row per order
**before** joining to `orders`/`customers`, using a CTE:

```sql
WITH order_totals AS (
  SELECT order_id, sum(line_total_cents) AS order_revenue_cents
  FROM order_lines
  GROUP BY order_id
)
SELECT
  c.id, c.full_name,
  count(o.id)                    AS order_count,   -- now correct
  sum(ot.order_revenue_cents)    AS revenue_cents
FROM customers c
JOIN orders o        ON o.customer_id = c.id
JOIN order_totals ot ON ot.order_id = o.id
GROUP BY c.id, c.full_name;
```

Real output for the same customers:

```json
{"customerName":"Ward Brown","orderCount":6,"actualOrderCount":6,"matches":true,"revenueCents":"1958607"}
{"customerName":"Bertha Gerhold","orderCount":4,"actualOrderCount":4,"matches":true,"revenueCents":"1256380"}
{"customerName":"Johnpaul Schmeler","orderCount":5,"actualOrderCount":5,"matches":true,"revenueCents":"1214529"}
```

By the time `orders` is joined to `order_totals`, every order contributes
exactly one row - `order_totals` already collapsed `order_lines` down to one
row per `order_id` - so `count(orders.id)` is finally counting what it looks
like it's counting. The revenue figure is unchanged, because it was never
wrong.

## Why the fix works

The general rule: when a report needs a value from a one-to-many child table
(`order_lines`, here) *and* a count of the parent (`orders`), never join the
child in raw and count across the join - aggregate the child down to one row
per parent first (a CTE, or a subquery in the `FROM` clause), then join.
That ordering makes the fan-out structurally impossible instead of relying
on remembering to write `DISTINCT` in the right place.

A narrower fix also exists: change `count(orders.id)` to
`count(DISTINCT orders.id)` in the *original*, non-pre-aggregated query.
`src/scenarios/naive-report.ts`'s own `actualOrderCounts` helper effectively
does this (`count(*)` grouped directly on `orders`, no fan-out to begin
with), and `src/scenarios/aggregations.ts`'s customer-revenue query uses
`countDistinct(orders.id)` for exactly this reason. It is correct and cheap.
Its limitation is that it only fixes *this* symptom: the moment a second
one-to-many relationship joins in (refunds, shipments, returns), `count(
DISTINCT orders.id)` is still correct for the order count, but a `count(
DISTINCT refunds.id)` or `sum(refund_amount_cents)` added to the same query
reintroduces a *new* fan-out that DISTINCT on a different column doesn't
fix. Pre-aggregating each one-to-many branch in its own CTE before joining
scales to any number of child tables; sprinkling `DISTINCT` in the right
places does not.

## Tradeoffs

- **CTE pre-aggregation vs `COUNT(DISTINCT ...)`**: the CTE fix is more
  verbose for a single fan-out but generalizes cleanly to multiple joined
  one-to-many relationships (see above). `COUNT(DISTINCT ...)` is a one-line
  fix for exactly one fan-out and reads naturally once you know to look for
  it, but it is a patch per symptom, not a structural fix.
- **Window functions: raw SQL vs Drizzle**: Drizzle's query builder has no
  `.over()` API - every window function in this lab (`SUM(...) OVER (...)`,
  `RANK() OVER (...)`) is written as a raw `sql` fragment even in the
  "Drizzle" version of `src/scenarios/window-functions.ts`. This is a real
  limitation, not a lab simplification: for genuinely window-function-shaped
  queries, reach for raw SQL first per CLAUDE.md's "ORM plus SQL" principle,
  and use Drizzle for the surrounding `FROM`/`JOIN`/CTE structure.
- **`NOT EXISTS` vs `NOT IN`**: `src/scenarios/subqueries.ts` uses
  `NOT EXISTS` for "products never ordered" instead of `product_id NOT IN
  (SELECT product_id FROM order_lines)`. If the subquery's result ever
  contains a `NULL` `product_id` (it can't here - `product_id` is `NOT
  NULL` - but in general it could), `NOT IN` against a set containing NULL
  returns zero rows for the *entire* outer query, silently, because `x <>
  NULL` is unknown rather than true or false. `NOT EXISTS` has no such
  failure mode. Prefer `NOT EXISTS` for anti-joins as a default habit.
- **No indexes in this lab**: every query plans as a sequential scan, which
  is correct pedagogically (Lab 04 is where indexes are introduced and
  measured) but means this lab's queries would be genuinely slow on a
  production-sized table. Do not copy this schema into a real system without
  reading Lab 04 first.

## Production notes

1. **What guarantee does this technique provide?** None of this lab is
   about a correctness guarantee in the transactional sense (see Lab 05+)
   - it's about queries returning the answer you actually intended to ask
   for. The join-fan-out fix guarantees a `COUNT` across a join reflects
   distinct parent rows, not joined result rows.
2. **What does it not guarantee?** Nothing here protects against a
   fundamentally wrong query (a missing `WHERE status != 'cancelled'`, a
   join on the wrong column) - only against the specific, common shape of
   "count inflated by an unrelated join".
3. **What breaks under process crash?** Not applicable - every script here
   is read-only except the seed script, which is idempotent (delete-then-
   insert) and safe to rerun after a crash.
4. **What breaks under network partition?** Not applicable at this scale -
   single Postgres node, no replicas yet (see Lab 24+).
5. **What changes at high contention?** Not exercised here - every query in
   this lab is a `SELECT`. Aggregation/join cost under concurrent writes is
   a Lab 04/33 topic (index-supported plans, `pg_stat_activity`).
6. **What changes with multiple regions?** Not applicable yet.
7. **What metrics would you monitor?** In production, `pg_stat_statements`
   for total time and call count per query shape, and `EXPLAIN (ANALYZE,
   BUFFERS)` output for any query whose row-count estimate badly diverges
   from its actual row count (a sign statistics are stale - `ANALYZE` the
   table).
8. **What simpler alternative could be used?** For the fan-out bug
   specifically, `COUNT(DISTINCT ...)` is the simpler alternative when there
   is exactly one fan-out to fix - see "Why the fix works" for when it stops
   being enough.
9. **When should you avoid this technique?** Don't reach for a CTE where a
   single `GROUP BY` with no fan-out risk already answers the question
   (e.g. `src/scenarios/aggregations.ts`'s revenue-per-category query) -
   CTEs add a name and a boundary that are only worth it when they prevent a
   real correctness problem or meaningfully improve readability.

## Interview questions

1. Why does `COUNT(orders.id)` overcount after joining `orders` to
   `order_lines`, while `SUM(order_lines.line_total_cents)` in the exact
   same query does not?
2. What's the general rule for deciding whether a report needs a CTE that
   pre-aggregates a child table before joining, versus a single `GROUP BY`?
3. Why is `NOT EXISTS` usually preferred over `NOT IN` for an anti-join
   against a subquery?
4. `RANK()` and `ROW_NUMBER()` both number rows in an ordered partition -
   what's the practical difference, and when would ties make that
   difference visible?
5. When would you reach for a window function instead of a self-join to
   compute a running total?
6. Why did this lab's raw SQL queries return `bigint` columns as strings
   while Drizzle returned the same logical column as a number - and what
   real bug did that difference cause in this lab's own code?
7. Given `EXPLAIN` shows three sequential scans and two hash joins for a
   three-table join with no indexes, what would you expect to change (and
   what would you expect to stay the same) if you added an index on the
   join columns?

## Further experiments

- Add a `refunds` table (`order_id`, `amount_cents`) with a handful of rows
  and try writing "total revenue and refund count per customer" in one
  query that joins `orders`, `order_lines`, AND `refunds` - watch the
  fan-out reappear in a new shape (two child tables joined to the same
  parent), and fix it by pre-aggregating each child in its own CTE before
  the final join.
- Change `src/scenarios/window-functions.ts`'s leaderboard query from
  `RANK()` to `DENSE_RANK()` and to `ROW_NUMBER()`, seed two customers with
  identical revenue (edit the generator or insert by hand), and compare all
  three outputs.
- Run `pnpm demo:explain` after commenting out the `LIMIT 5`, and compare
  the plan's cost estimates and the `Sort` step - does Postgres still choose
  a `top-N heapsort`?
- Increase `--size` in `pnpm seed` to `medium` or `large` and rerun
  `pnpm demo:explain` - the plan shape (sequential scans, hash joins, hash
  aggregate) should stay the same, but compare the estimated and actual row
  counts and costs.
- Rewrite `src/scenarios/ctes.ts`'s two chained CTEs as a single query with
  a subquery nested in the `FROM` clause instead, and decide for yourself
  whether the CTE version is actually more readable, or just more familiar.
