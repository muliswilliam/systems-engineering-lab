# Lab 34 - Pagination at Scale: OFFSET vs. Keyset (Cursor) Pagination

## Why this exists

`SELECT * FROM table ORDER BY created_at LIMIT 20 OFFSET 100000` looks
harmless - it reads like "give me page 5,001." It is one of the most common
correctness-and-performance mistakes in backend engineering, because it
looks fine in every manual test a developer runs (small tables, page 1,
page 2, maybe page 10) and only degrades once a table reaches real
production scale and users actually scroll deep - by which point it is
already live, already indexed "correctly" by someone's best-effort
`CREATE INDEX`, and still measurably getting slower and, separately,
occasionally handing back a row twice or dropping one entirely.

Both problems have the same root cause: `OFFSET N` is a statement about
**position** in a result set, not about **identity**. Postgres has to
materialize (or at least walk past) every row before position N to know
what "position N" even means right now, and "right now" can differ between
two requests a few hundred milliseconds apart if anything was inserted or
deleted in between. Keyset (cursor) pagination replaces "the Nth row" with
"the first row after this specific row I already saw," which is both a
cheaper question for an index to answer and a well-defined question even
while the table keeps changing underneath it.

## Learning objectives

After this lab you should be able to:

- explain precisely why an index on the `ORDER BY` column does not save
  `OFFSET` pagination from an O(offset) cost, using real `EXPLAIN ANALYZE`
  evidence, not just "OFFSET is slow" folklore;
- reproduce a real, verified duplicate row and a real, verified skipped row
  caused by `OFFSET` pagination racing against concurrent inserts/deletes;
- implement keyset pagination correctly, including the composite
  `(created_at, id)` tuple comparison needed once two rows can tie on the
  sort column;
- state keyset pagination's guarantee precisely: it never skips or
  duplicates a row that existed in the already-fetched range at
  cursor-capture time - and state its real, non-trivial limitation just as
  precisely: it is not a frozen snapshot, so a row landing later in the
  as-yet-unfetched range can still appear;
- explain the real UX/API-shape tradeoff keyset pagination costs you (no
  arbitrary "jump to page 50") and when that tradeoff is and is not
  acceptable;
- explain why `COUNT(*)` is a genuinely separate, genuinely expensive
  operation from "give me the next page," and why infinite-scroll UIs are
  right to avoid it.

## Architecture

```text
activity_events (id, public_id, actor_name, action, target_type, target_id, created_at)
  index: activity_events_created_at_id_idx ON (created_at, id)
```

A fresh, standalone table - not one of `SPEC.md` section 8.2's five named
domains. Pagination-at-depth is a mechanism lesson about how `OFFSET` and
keyset pagination behave against a large, append-mostly, chronologically
ordered table, not a rich relational model - the same "small standalone
table, the lesson is the mechanism" rationale as Lab 06's `counters` / Lab
23's `widgets` / Lab 30's `orders` / Lab 31's `page_views`. A platform
activity feed (an admin audit log / a "recent activity" timeline, modeled
loosely on a GitHub/Jira-style feed: `"alice merged pull_request #4821"`) is
the most natural real-world fit for deep pagination - it is exactly the
kind of table users and API clients genuinely do scroll or page deep into,
ordered by recency.

`created_at` is deliberately generated at whole-**second** granularity
(see `src/seed/generator.ts`), not full microsecond precision. A busy feed
genuinely logs multiple events in the same wall-clock second, and that is
exactly why `ORDER BY created_at` alone is not a valid total order - two
rows can tie. Both the naive and the keyset query in this lab always order
by (and the single index covers) the tuple `(created_at, id)`, using `id`
purely as a deterministic tie-breaker. This is not a contrived edge case;
with a mean simulated inter-event arrival of 2 seconds, roughly 39% of
consecutive events land in the same second (see the doc comment on
`walkTimestamps` in `src/seed/generator.ts` for the derivation) - ties are
the normal case, not the exception.

```text
src/seed/generator.ts                   <- deterministic, streamed/batched event generator
src/seed/seed.ts                        <- --size=small|medium|large or --rows=N
src/scenarios/pagination-lib.ts         <- shared OFFSET/keyset query + EXPLAIN ANALYZE helpers
src/scenarios/offset-pagination.ts      <- Point 2: naive OFFSET, real measured degradation curve
src/scenarios/keyset-pagination.ts      <- Point 3: keyset, real measured flat cost at same depths
src/scenarios/offset-correctness-bug.ts <- Point 2: real duplicate-row and skipped-row reproduction
src/scenarios/keyset-correctness.ts     <- Point 3: same mutations, keyset's real guarantee + limitation
src/scenarios/count-cost.ts             <- Point 5: COUNT(*) cost vs. a keyset page fetch
```

## Setup

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:migrate
pnpm seed                    # fast default: --size=small, 20,000 rows, ~0.5s
```

For the real depth benchmarks in this README, reseed at the size they were
captured against:

```bash
pnpm seed -- --size=large    # 600,000 rows; took ~12.5s on the machine this
                              # README's numbers were captured on
```

`pnpm seed` (no args) always defaults to `--size=small` so `pnpm test` and
casual `pnpm dev` runs stay fast - see "Data Generation" in `CLAUDE.md`.
`--rows=N` is also supported for an exact row count.

## Scenario

You maintain the activity feed for a dev-collaboration platform (think a
GitHub/Jira-style "recent activity" audit log). Product wants two things
from the same underlying feed:

1. An admin-facing paginated table with page numbers ("Page 1 2 3 ... 50 ▸")
   and the ability to jump straight to page 200.
2. A public, infinite-scrolling activity feed that just keeps loading more
   as the user scrolls.

Both are currently implemented the same way: `ORDER BY created_at, id LIMIT
20 OFFSET (page - 1) * 20`. It works fine in QA (a few hundred rows). In
production, the table has 600,000+ rows and grows continuously.

## Prediction

Before running anything, write down answers to these:

1. There is a B-tree index on `(created_at, id)`, the exact columns in the
   `ORDER BY`. Will fetching page 20,001 (`OFFSET 400000`) be roughly as
   fast as fetching page 1, since the index means Postgres "knows where
   sorted row 400,000 is"? Why or why not?
2. A user is on page 6 of the admin table. Between their request for page 6
   and their click to page 7, someone deletes a row that was on page 5 (a
   page they already saw). What, if anything, goes wrong with page 7?
3. Could switching to keyset pagination make problem #2 impossible? Could it
   introduce a different, smaller correctness quirk of its own?

## Exercise

```bash
pnpm seed -- --size=large

pnpm scenario:offset              # naive OFFSET degradation curve
pnpm scenario:keyset              # keyset at the SAME depths

pnpm seed -- --size=small         # cheap, fast dataset for the bug demos below
pnpm scenario:correctness-bug     # reproduces a real duplicate AND a real skip
pnpm scenario:keyset-correctness  # same mutations against keyset - and its real limit
pnpm scenario:count-cost          # COUNT(*) cost vs. a keyset page fetch

pnpm test                         # invariant + regression tests, own isolated seeding
```

## Observe

- **`pnpm scenario:offset` output** - `medianExecutionMs` and
  `sharedBuffersTouched`, both real numbers Postgres itself reported via
  `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, growing with `OFFSET`.
- **`topNodeType` / the raw plan** - every depth uses an `Index Scan` on
  `activity_events_created_at_id_idx` under a `Limit` node. The index IS
  being used at every depth; that is precisely the point being demonstrated
  - using the index does not make the cost depth-independent.
- **`pnpm scenario:keyset` output** - the same metrics, essentially flat
  across the same depths.
- **`pnpm scenario:correctness-bug` output** - `duplicateDetected: true`
  and `skipDetected: true`, with the actual `public_id` values proving it.
- **PGweb** (`http://localhost:8434`) - browse `activity_events`, sort by
  `created_at, id`, and manually try the same offset math this lab automates.
- `EXPLAIN (ANALYZE, BUFFERS) SELECT ... OFFSET 400000 LIMIT 20;` run by
  hand in `psql` or PGweb's query tab - look for `Rows Removed by Filter`
  vs. `Limit`/`Index Scan` cost accounting directly in the plan text.

## Break it

Run:

```bash
pnpm seed -- --size=small
pnpm scenario:correctness-bug
```

Real, captured output from this repository (600,000-row table reseeded to
5,000 for a fast, legible demo; `PAGE_SIZE=20`, `OFFSET=100`):

```text
fetched page 1 (rows at positions 100-119)
  lastRowPublicId: "ed8fb196-4767-4d79-9baf-025b6df80a89"

a NEW event was inserted with created_at BEFORE every existing row
  insertedPublicId: "2869d8fc-d096-4dbd-8625-997f474efd9b"

BUG REPRODUCED: page 2 (OFFSET 120) starts with the SAME row that was
already the LAST row of page 1
  page2FirstRowPublicId: "ed8fb196-4767-4d79-9baf-025b6df80a89"   <- duplicate
  duplicateDetected: true

before any mutation, the row that WOULD be page 2's first row (position 120)
  victimPublicId: "a881ae8c-a55c-4db4-8e23-18b438c91b86"

a row INSIDE the already-delivered page 1 window was deleted (position 105)

BUG REPRODUCED: the row that would have been page 2's first row was NEVER
delivered - not in page 1, not in page 2
  presentInPage1: false
  presentInPage2AfterDelete: false
  skipDetected: true
```

Why this happens, precisely: `OFFSET` counts **rows from the start of the
current result set**, evaluated fresh on every query. Insert a row that
sorts before the window, and every row after it shifts down one position -
`OFFSET 120` now points at what used to be position 119, already delivered
in page 1. Delete a row before the window, and every row after it shifts up
one position - `OFFSET 120` now points at what used to be position 121,
and whatever used to be at position 120 is never returned at any offset the
client will ever request.

## Fix it

Keyset pagination replaces "skip N rows" with "give me the rows
immediately after this specific row I already have":

```sql
-- Naive (this lab's "break it"):
SELECT * FROM activity_events
ORDER BY created_at, id
LIMIT 20 OFFSET 100000;

-- Keyset (this lab's fix) - cursor = (created_at, id) of the LAST row of
-- the previous page:
SELECT * FROM activity_events
WHERE (created_at, id) > ($lastSeenCreatedAt, $lastSeenId)
ORDER BY created_at, id
LIMIT 20;
```

Run:

```bash
pnpm seed -- --size=large
pnpm scenario:offset
pnpm scenario:keyset
```

Real, captured output from this repository (600,000-row table,
`PAGE_SIZE=20`, median of 5 real `EXPLAIN ANALYZE` runs per depth):

| Depth (OFFSET) | Page  | OFFSET: median execution time | OFFSET: buffers touched | Keyset: median execution time | Keyset: buffers touched |
| -------------: | ----: | -----------------------------: | -----------------------: | ------------------------------: | ------------------------: |
|              0 |     1 |                        0.017 ms |                         8 |                         0.014 ms |                          8 |
|          2,000 |   101 |                        0.174 ms |                        72 |                         0.017 ms |                          8 |
|         20,000 |  1001 |                        1.480 ms |                       652 |                         0.013 ms |                          8 |
|        100,000 |  5001 |                        8.153 ms |                     3,272 |                         0.011 ms |                          8 |
|        400,000 | 20001 |                       28.702 ms |                    13,144 |                         0.012 ms |                          8 |

OFFSET pagination got **1,688x slower** from page 1 to page 20,001 in this
run, and its `sharedBuffersTouched` grew in near-exact proportion to the
offset (buffers are a deterministic metric, immune to machine-speed noise -
see the tests). Keyset pagination touched **exactly 8 shared buffers at
every single depth**, from page 1 through page 20,001, with execution time
staying in a 0.011-0.017 ms band regardless of depth.

`pnpm scenario:keyset-correctness` then re-runs the exact same two
mutations from "Break it" against keyset pagination. Real captured output:

```text
NO DUPLICATE: inserting a row before the cursor cannot affect
`WHERE (created_at, id) > cursor` - page2Unchanged: true

NO SKIP: deleting an already-delivered row from page 1 has ZERO effect
on page 2 - page2Unchanged: true

DOCUMENTED LIMITATION (not a bug): a row inserted AFTER the cursor,
sorting WITHIN page 2's range, DOES appear - newRowAppeared: true
```

## Why the fix works

The `(created_at, id)` composite index is a sorted structure. `WHERE
(created_at, id) > ($1, $2)` is a **row-wise tuple comparison** - Postgres
evaluates it exactly like comparing two-column tuples lexicographically -
so the planner can seek directly to the first index entry greater than the
cursor (an O(log n) B-tree descent) and then read `LIMIT` rows forward.
There is nothing before the cursor to walk past, because the query never
asks "skip N" - it asks "start after this specific value," which the index
can answer directly regardless of how deep that value is in the overall
order.

`OFFSET N` cannot use the index this way because "the Nth row" is not a
value the index stores - it is a *position*, and position is only knowable
by actually counting through the sorted rows. The index still helps (it
avoids an expensive full sort), which is why `topNodeType` shows `Limit`
over an `Index Scan` at every depth in this lab's OFFSET scenario too - but
walking past N rows is still O(N) work no index eliminates.

The correctness guarantee follows from the same mechanism: keyset
pagination's `WHERE` clause never re-examines anything at or before the
cursor. A row's identity, not its position, determines whether it appears
in the next page. Deleting or inserting rows before the cursor cannot
change what the query considers "greater than the cursor," so the
already-delivered range is never revisited.

**What this fix does NOT guarantee** (documentation quality, not just a
performance claim): keyset pagination is not a frozen snapshot. It
re-reads the live table on every request. A row inserted with a tuple value
that sorts strictly after the cursor - i.e., into territory the client has
not fetched yet - genuinely can and will appear in a later page, even
though it did not exist when the client started paginating. This is
different from the OFFSET bug: it is not a duplicate, not a skip, and not
inconsistent with "the current state of the table sorted by
`(created_at, id)`" - it is simply live data. If a client needs a fully
frozen, point-in-time view across many pages (rare, but real - e.g., an
export job), keyset pagination alone does not provide it; that requires an
explicit snapshot mechanism (e.g., `REPEATABLE READ`/`SERIALIZABLE` held
open across the whole export, or a `snapshot_at` filter column), which is
out of scope for this lab.

## Tradeoffs

| | OFFSET | Keyset (cursor) |
| --- | --- | --- |
| Cost at depth | O(offset) - grows without bound | O(log n) - flat |
| Duplicate/skip under concurrent writes | Yes, real and reproducible (see "Break it") | No, for the already-fetched range |
| Frozen-snapshot guarantee | No (same live-read caveat) | No (documented above) |
| **Arbitrary page jump ("go to page 200")** | **Yes** - just compute `OFFSET` | **No** - requires the cursor of the page immediately before it |
| Requires client to store state between requests | No (page number is stateless, computable from the URL) | Yes (must carry the last row's cursor forward) |
| `COUNT(*)` / "N results" / "Page X of Y" UI | Natural fit, but see `scenario:count-cost` - the count itself is a separate, real cost | Awkward - keyset has no natural page number at all |
| Implementation complexity | Trivial | Slightly more - needs a composite key, a tie-breaker column, and an index that matches the sort exactly |
| Best fit | Small/medium tables, admin UIs that need real page-N navigation, low page depth | Large or fast-growing tables, infinite scroll / "load more" feeds, APIs iterating a full dataset |

The page-jump tradeoff is real and not merely theoretical: keyset
pagination fundamentally cannot answer "show me page 200" without either
(a) walking forward from page 1 anyway (defeating the point), or (b)
maintaining a separate, periodically-refreshed index of "every Nth cursor"
as a page-jump table - extra machinery, extra staleness, extra
maintenance. If a product genuinely needs numbered-page jump navigation at
depth, OFFSET (possibly with a cached/approximate total count) may remain
the pragmatic choice for that specific view, accepting its cost and
correctness caveats, while an infinite-scroll or "next page" only view of
the *same underlying table* uses keyset. Nothing prevents a single API from
offering both a `?page=N` OFFSET-backed endpoint capped at a shallow
maximum depth (many production APIs cap OFFSET at e.g. 10,000 for exactly
this reason) and a `?cursor=...` keyset-backed endpoint for unlimited depth.

## Production notes

1. **What guarantee does this mechanism give?** Keyset pagination
   guarantees that a row present in the table at the moment its page was
   fetched, and already delivered to the client, will never be re-delivered
   or silently dropped from a later page as a *direct result of insertions
   or deletions elsewhere in the table*. It guarantees consistent progress
   through the `(created_at, id)` order regardless of how deep the cursor
   already is.
2. **What guarantee does it not give?** It does not guarantee a
   point-in-time consistent snapshot across the whole pagination session -
   new rows landing ahead of the cursor will appear; rows landing far behind
   the cursor are invisible by design, not by accident. It also does not
   give you a total row/page count for free.
3. **What failure mode remains?** If the cursor's row itself is deleted
   between page fetches, `WHERE (created_at, id) > (deleted_value)` still
   works correctly (Postgres compares against the *value*, not a live row
   reference), but a client that lost its cursor value entirely (crash,
   dropped session) has no way to resume except restarting from the
   beginning - unlike OFFSET, where any page number is independently
   reconstructable.
4. **How does contention affect it?** Both approaches are read paths and
   take no locks against writers under default `READ COMMITTED`; keyset's
   advantage is scan cost, not lock contention. Very hot insert-at-the-front
   feeds do not slow down keyset pagination, since the cursor's position in
   the index does not move.
5. **What changes at larger scale?** OFFSET's cost curve only gets worse -
   it is linear in offset, so a 10x larger table makes deep pages 10x more
   expensive at the same page number. Keyset's cost stays governed by
   B-tree height (logarithmic), so it scales far more gracefully; the
   practical limit becomes index bloat/maintenance and buffer cache
   pressure, not scan depth.
6. **What metrics would be monitored?** p50/p95/p99 query latency broken
   out by requested depth/page (a flat p99 across depths is the signal
   keyset is working); `pg_stat_statements` mean/max time and calls for the
   pagination query; buffer hit ratio for the covering index; for OFFSET
   endpoints specifically, a histogram of requested `OFFSET` values (a
   ballooning tail is an early warning of an unbounded "load more" UI
   quietly becoming a deep-scroll UI).
7. **When should this approach be avoided?** Keyset pagination is the wrong
   tool when the product genuinely requires random page-N access (numbered
   pagination widgets, "jump to page"), when the sort key is not stable or
   not indexable as a tuple (e.g., sorting by a frequently-recomputed
   relevance score with ties on nothing durable), or when the dataset is
   small enough that OFFSET's cost is immaterial and its simplicity is
   worth more than the guarantee.

## Interview questions

1. Why doesn't an index on the `ORDER BY` column save `OFFSET` pagination
   from linear cost as the offset grows? What, specifically, does the index
   let Postgres skip, and what can it not skip?
2. Walk through exactly how a row insertion causes a duplicate across two
   `OFFSET` page requests, and exactly how a deletion causes a skip. Why are
   these different mechanisms with the same symptom category
   ("pagination correctness bug")?
3. Why must keyset pagination's `ORDER BY`/index be on a tuple like
   `(created_at, id)` rather than `created_at` alone? What specifically
   breaks if two rows can tie on `created_at` and you only compare on it?
4. Keyset pagination is often described as "immune to the OFFSET bug." Is
   that fully accurate? What can still change between two keyset page
   fetches, and why is that not the same class of bug?
5. A product manager asks for both "infinite scroll" and "jump to page 200"
   on the same feed. How would you architect the two endpoints, and what do
   you tell them about the cost/consistency difference between them?
6. Why is `COUNT(*)` expensive in PostgreSQL even when the `WHERE` clause is
   indexed? Under what circumstances would you cache, approximate, or
   simply omit a total count instead of computing it live on every request?
7. If you needed a genuinely frozen, point-in-time paginated view (e.g., for
   a data export), would keyset pagination alone be sufficient? What
   additional mechanism would you add?

## Further experiments

- Change `PAGE_SIZE` in the scenario scripts (e.g., 100 instead of 20) and
  re-run - does the OFFSET-vs-keyset gap grow, shrink, or stay proportionally
  the same?
- Seed with `--rows=2000000` (a couple minutes on most machines) and re-run
  `scenario:offset` at `--depths=1000000,1900000` - does the degradation
  curve stay linear, or does something else (buffer cache eviction, cold
  I/O) start to dominate?
- Drop the `activity_events_created_at_id_idx` index entirely
  (`DROP INDEX activity_events_created_at_id_idx;` in PGweb) and re-run
  `scenario:offset` - watch `topNodeType` change to a `Sort` over a `Seq
  Scan` and compare the new (much worse) numbers to this README's table.
- Modify `keyset-correctness.ts` to insert a row with a tuple value BEFORE
  the very first cursor position (page 1's own cursor) instead of after -
  confirm it changes what page 1 itself would return on a fresh fetch,
  which is expected and different from the "duplicate/skip in the
  already-fetched range" guarantee this lab is about.
- Implement a backward ("previous page") keyset query using `<` instead of
  `>` and `ORDER BY created_at DESC, id DESC`, then reverse the result in
  the application layer - this is the standard way real APIs (e.g., GitHub's
  REST API `before`/`after` cursors) support both-direction cursor paging.
- Add a `snapshot_at` column and explore what a "frozen view" pagination
  API would need to look like to give exporters the point-in-time guarantee
  keyset pagination explicitly does not provide (see "Why the fix works").
