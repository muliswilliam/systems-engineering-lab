# Lab 30 - Large Table Backfills

## Why this exists

Lab 29 taught expand/contract and showed a batched backfill as one phase of
a bigger migration - but at 500 rows, a single giant `UPDATE` would have
"worked fine" too, so the danger it's meant to teach you to avoid never
actually showed up. This lab isolates backfill mechanics on their own, at a
scale where the naive approach becomes genuinely dangerous, not just
theoretically so: a single `UPDATE ... WHERE ...` against a million-row
table doesn't just run "a bit slower" - it holds row locks on every row it
touches for its ENTIRE duration, so an ordinary, completely unrelated write
against ANY of those rows queues up behind it for that whole time. This is
the real, common production incident: "the migration finished in 5 seconds,
but every checkout request that touched an order during those 5 seconds
timed out." This lab reproduces that incident with real numbers on a real
Postgres instance, then fixes it with a small, rate-limited, resumable
batch loop and proves - by really killing the process mid-run - that
resuming picks up exactly where it left off.

## Learning objectives

After this lab you should be able to:

- explain precisely why a single `UPDATE` touching N rows blocks an
  unrelated write to any one of those N rows for the UPDATE's entire
  duration, not just while that specific row is being processed;
- measure, with a real held transaction and a real concurrent write, the
  difference between "genuinely blocked" (a real SQLSTATE `55P03` lock
  timeout) and "somewhat slower";
- design a batched backfill loop that is simultaneously correct, resumable,
  and rate-limited, and explain why the `WHERE column IS NULL` predicate is
  what makes resumability free instead of something you have to build;
- explain, at least at a conceptual level, why a single long-running
  transaction also grows table bloat system-wide for its whole duration -
  not just in the table it's writing to - and why that is a separate problem
  from lock contention;
- reproduce a REAL process kill (`SIGKILL`) mid-backfill and prove, with
  real row counts, that resuming neither re-processes nor skips a single
  row.

## Architecture

```text
orders (id, public_id, customer_email, amount_cents, status, created_at, loyalty_points)
```

A fresh, standalone `orders` table - NOT SPEC.md section 8.2's full
commerce model (customers/products/order_lines), and NOT imported from any
other lab's `orders` table (Lab 16, Lab 20). This lab is about the
MECHANICS of backfilling a very large table, not a rich relational domain -
the same "small standalone table, the lesson is the mechanism" rationale as
Lab 06's `counters`/Lab 11's `documents`/Lab 23's `widgets`. A flat table
with a realistic commerce-shaped column set (customer email, amount,
status) is enough to make the backfill computation meaningful without
needing joins. No `@labs/data-generators` generator was added for this
lab's shape - Faker is called directly in `src/seed/seed.ts`, the same "no
speculative shared machinery ahead of a second consumer" reasoning as Lab
16/19/23's own standalone-schema seed scripts.

`loyalty_points` is this lab's backfill target: a derived column (1 point
per whole dollar spent, `floor(amount_cents / 100)`) that did not exist
when most of this table's rows were written. **Lab 29 already covered `ADD
COLUMN ... nullable` being an instant, pure-catalog change regardless of
table size - that step is deliberately NOT re-demonstrated here.** This lab
starts one step later: the column already exists, every pre-existing row
has `loyalty_points IS NULL`, and someone has to actually populate it for
up to a million-plus rows without degrading production.

A partial index, `idx_orders_loyalty_points_pending ON orders (id) WHERE
loyalty_points IS NULL`, is part of the schema from the start - without it,
the batched backfill's own `WHERE loyalty_points IS NULL ORDER BY id LIMIT
$1` query would degrade into a sequential scan of the whole table on every
single batch once most rows are already done, defeating the entire point
of batching.

Four scripts:

```text
src/seed/seed.ts                             <- batched/streamed seed, --size=small|medium|large or --rows=N
src/scenarios/naive-giant-update.ts          <- the incident: one UPDATE, real blocking measured
src/scenarios/batched-resumable-backfill.ts  <- the fix: small batches, paced, resumable
src/scenarios/interrupted-resume-backfill.ts <- a REAL SIGKILL mid-run, then resume, then verify
src/scenarios/write-prober.ts                <- shared "ordinary concurrent write" latency measurement, used by all three
```

## Setup

```bash
pnpm install
cp labs/30-large-table-backfills/.env.example labs/30-large-table-backfills/.env
cd labs/30-large-table-backfills
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - the migration is already checked in
pnpm db:migrate
pnpm seed          # default: --size=small, 20,000 rows, a few hundred ms
```

Open PGweb at http://localhost:8430 (auto-connects via
`PGWEB_DATABASE_URL`). You should see 20,000 rows in `orders`, all with
`loyalty_points` still `NULL`.

**This lab's `pnpm seed` sizes:**

| `--size=` | rows | seed time (measured) | intended use |
|---|---|---|---|
| `small` (default) | 20,000 | 185ms | `pnpm test`, quick interactive runs |
| `medium` | 200,000 | 1.6s | "see it for yourself" without a long wait |
| `large` | 1,000,000 | 8.6s | the real "Break it" / "Fix it" numbers below |

`--rows=N` overrides any preset, e.g. `pnpm seed --rows=5000000`.

## Scenario

`orders` has grown to a million rows in production. A new feature needs a
`loyalty_points` column backfilled for every existing order (the column
itself was already added safely, nullable, no default - see Lab 29). The
obvious first draft is one `UPDATE` statement. It is correct. It is also,
at this scale, a production incident waiting to happen.

## Prediction

Before running anything, predict:

1. A single `UPDATE orders SET loyalty_points = ... WHERE loyalty_points IS
   NULL` is issued against a 1,000,000-row table. How long does it take,
   roughly? While it's running, does an ordinary `UPDATE orders SET status
   = ... WHERE id = 1` (a completely unrelated user action) succeed quickly,
   slowly, or not until the first UPDATE finishes?
2. The same backfill is done instead as 1,000 separate `UPDATE ... LIMIT
   1000` batches, with a short pause between each. Does the SAME ordinary
   write behave differently now? Why?
3. The batched version is killed (`kill -9`) after committing 40% of its
   batches. What state is the table in? What happens if you just run the
   exact same script again?

## Exercise

1. Run the setup commands above, then seed the large dataset:
   ```bash
   pnpm seed --size=large
   ```
2. Run the naive scenario and watch it hurt an unrelated write on purpose:
   ```bash
   pnpm scenario:naive
   ```
3. Reseed (the naive run just backfilled everything) and run the fix:
   ```bash
   pnpm seed --size=large
   pnpm scenario:batched
   ```
4. Reseed a smaller dataset and watch a real process get killed and resumed:
   ```bash
   pnpm seed --size=small
   pnpm scenario:interrupted-resume
   ```
5. Run `pnpm test` and read `tests/integration/*.test.ts` - these assert
   the same invariants as real, automated checks (resumability, no
   double-processing, and a deterministic proof of blocking via a real
   `lock_timeout` failure rather than a timing race).

## Observe

- **PGweb** (http://localhost:8430): watch `loyalty_points` fill in as
  `scenario:batched` runs - refresh mid-run and you'll see a genuine mix of
  `NULL` and populated rows, something the naive scenario never shows you
  (it's all-or-nothing from the outside).
- **`docker compose logs postgres`**: `log_lock_waits=on` logs when a
  backend has been waiting on a lock past `deadlock_timeout` - visible
  during `scenario:naive`, silent during `scenario:batched`.
- **`SELECT pid, mode, granted, relation::regclass FROM pg_locks WHERE
  relation = 'orders'::regclass;`**: run this from a second `psql` session
  while `scenario:naive` is running and see the ordinary write's lock
  request sitting at `granted = false` for the whole time.
- **`SELECT pid, now() - xact_start AS age, query FROM pg_stat_activity
  WHERE datname = current_database();`**: contrast one long-lived
  transaction (naive) against a stream of many short-lived ones (batched).
- **Structured logs**: every scenario logs real row counts, batch numbers,
  durations, and latency percentiles through `@labs/logging` (Pino) - not
  just a final pass/fail.

## Break it

Real captured output from this lab's own validation run (`--size=large`,
1,000,000 rows, all `loyalty_points IS NULL`):

```bash
pnpm scenario:naive
```

```text
--- naive scenario: one giant UPDATE against the whole pending cohort ---
  totalRows: 1000000   pendingRows: 1000000   targetOrderId: 1

baseline: measuring an ordinary write's latency with NO contention
  baselineLatencyMs: 11.01

issuing the naive giant UPDATE (not yet awaited) ...
starting ordinary-write probes against the SAME row while the giant UPDATE is in flight

naive giant UPDATE finished - every ordinary write attempted during its execution
was blocked until it committed
  naiveDurationMs: 5456.22   rowsUpdated: 1000000
  baselineLatencyMs: 11.01
  ordinaryWriteWhileBlockedMs: { count: 1, minMs: 5309.01, p50Ms: 5309.01, p99Ms: 5309.01, maxMs: 5309.01 }

the earliest ordinary write attempt was blocked for essentially the FULL duration
of the naive UPDATE - this is the incident
  worstCaseBlockedMs: 5309.01   naiveDurationMs: 5456.22   ratio: 0.973
```

The giant `UPDATE` took **5,456ms** for 1,000,000 rows. An ordinary,
completely unrelated write against order id 1 - the kind of write a real
"cancel my order" click would trigger - took **5,309ms**, **97.3% of the
entire naive statement's duration**, instead of its normal ~11ms. It was
not "a bit slower." It was genuinely stuck, queued behind a lock, for the
whole backfill.

**Why this happens:** `UPDATE ... WHERE loyalty_points IS NULL` is one
statement, and (with no explicit `BEGIN`) one implicit transaction.
Postgres takes a row-level lock on every row the statement touches as it
scans through the table, and - because it is all one transaction - holds
every one of those locks until the WHOLE statement commits, not just while
that particular row is being written. Row 1 gets touched and locked within
the first few rows of the scan; from that moment until the transaction
commits roughly 5.4 seconds later, ANY other session trying to write to row
1 (or any of the other 999,999 rows already touched) has to wait.

**The transaction-bloat angle (not separately demoed here - see Lab 31):**
a single long-running transaction has a consequence beyond locking. As long
as this transaction's snapshot is open, Postgres cannot vacuum away dead
tuples that snapshot could still see - not just in `orders`, but anywhere
in the database, because `VACUUM` must keep enough old row versions around
to satisfy the oldest still-running transaction's view of the world (the
same MVCC mechanism Lab 06 covers). A backfill that runs for 5 seconds
grows a small amount of unreclaimable bloat for those 5 seconds; a naive
backfill against a real production-sized table that runs for 20 minutes
does the same thing for 20 minutes, across every table receiving normal
write traffic in the meantime, not just the one being backfilled. Lab 31
(VACUUM, Autovacuum, and Bloat) measures this directly - this lab only
needs you to know it's happening.

## Fix it

Reseed (the naive run above already backfilled everything) and run the
batched version:

```bash
pnpm seed --size=large
pnpm scenario:batched
```

Real captured output, same dataset (1,000,000 rows, default `--batch-size=1000
--sleep-ms=50`):

```text
--- batched, resumable, rate-limited backfill ---
  totalRows: 1000000   pendingRows: 1000000   batchSize: 1000   sleepMs: 50

baseline: measuring an ordinary write's latency before the backfill starts
  baselineLatencyMs: 7.57

... 1,000 "batch committed" log lines ...

batched backfill complete - ordinary writes against the same row stayed close
to baseline the entire time
  batches: 1000   rowsBackfilled: 1000000   durationMs: 64214   rowsPerSecond: 15573
  baselineLatencyMs: 7.57
  ordinaryWriteDuringBackfillMs: { count: 303, minMs: 5.53, p50Ms: 10.81, p99Ms: 20.95, maxMs: 66.66 }
```

The full backfill took **64.2 seconds** (slower overall than the naive
version's 5.4 seconds - see "Tradeoffs" below), split into **1,000 batches
of 1,000 rows**, at **~15,600 rows/second**. During those entire 64
seconds, **303 separate ordinary writes** against the exact same row (id
1) were measured: **p50 10.81ms, p99 20.95ms, worst case 66.66ms** -
against a **7.57ms baseline**. Compare that worst case, 66.66ms, to the
naive scenario's 5,309ms: **roughly 80x less impact on an ordinary write,
for a backfill covering the identical million rows.**

**Resumability, proven with a REAL process kill:**

```bash
pnpm seed --size=small
pnpm scenario:interrupted-resume
```

Real captured output (20,000 rows):

```text
--- interrupted/resume scenario: starting state ---
  total: 20000   backfilled: 0   pending: 20000

spawning `pnpm scenario:batched` as a REAL child process, will SIGKILL it mid-run
  killAfterMs: 1000

... the child logs 8 real "batch committed" lines (batchSize=200, sleepMs=100) ...

child process is dead - it got no chance to log, flush, or clean up anything
  killed: true   code: null   signal: "SIGKILL"

state immediately after the kill - some batches committed, the rest did not run
  total: 20000   backfilled: 1800   pending: 18200

--- resuming: calling backfillLoyaltyPoints again, in-process, no maxBatches limit ---

... 37 more "batch committed" lines ...

resume run complete
  resumeBatches: 37   resumeRowsBackfilled: 18200   resumeDurationMs: 159

RESUMABLE, VERIFIED: killed run's rows + resumed run's rows account for exactly
the remaining work, zero double-processed, zero skipped, zero rows left NULL
  totalRows: 20000   alreadyBackfilledBeforeThisRun: 0
  firstRunRowsBeforeKill: 1800   secondRunRowsAfterResume: 18200
  finalPending: 0   invariantHolds: true
```

The child process received a **real `SIGKILL`** (`signal: "SIGKILL"`,
`killed: true`) - not a caught exception, not a graceful shutdown hook, no
chance to log or clean up anything. It had committed exactly **1,800 rows
(9 batches)** before dying. Resuming - calling the identical
`backfillLoyaltyPoints` function again, with no special "recovery mode" -
picked up the remaining **18,200 rows in 37 batches** and finished in
**159ms**. `1,800 + 18,200 = 20,000` - every row backfilled exactly once,
none skipped, none double-processed.

**One implementation note this demo had to solve, worth knowing:** the
first working version of this script spawned the child via `pnpm exec tsx
...`, which turned out to interpose a wrapper process that itself spawns a
separate Node process to actually run the script - `SIGKILL` to the
wrapper left the real process running as an undetected orphan, silently
defeating the whole demonstration (the "killed" run kept committing batches
in the background). The fix was to run `node --import tsx/esm
<script>` directly, so there is exactly one process, one pid, and `SIGKILL`
is immediate and final. This is itself a small real-world lesson: "kill the
process" and "kill the process TREE" are not always the same operation.

`pnpm test` captures the same invariants automatically:

```text
✓ tests/integration/batched-backfill.test.ts (4 tests)
✓ tests/integration/concurrent-write-blocking.test.ts (2 tests)

Test Files  2 passed (2)
     Tests  6 passed (6)
```

## Why the fix works

- **Each batch is its own short transaction.** `UPDATE ... WHERE id IN
  (SELECT id FROM orders WHERE loyalty_points IS NULL ORDER BY id LIMIT
  $1)` (no explicit `BEGIN`) commits and releases every row lock it took
  the instant that one batch finishes - never "the whole table for the
  whole backfill."
- **`WHERE loyalty_points IS NULL` makes resumability free, not something
  you build.** The predicate that selects "what still needs doing" is the
  same predicate that makes rerunning the loop after a crash safe: any row
  already backfilled no longer matches, so it can never be re-selected,
  and no row is ever skipped because nothing else ever sets the column.
- **The pacing (`sleepMs` between batches) is a deliberately simple rate
  limiter.** A fixed sleep isn't adaptive - it doesn't know if the database
  is actually under load - but it guarantees real idle time between
  batches, which is the property that matters here. See "Tradeoffs" for
  what a more sophisticated version would add.
- **The partial index (`WHERE loyalty_points IS NULL`) keeps the query
  itself fast as the pending cohort shrinks.** Without it, `ORDER BY id
  LIMIT $1` against `loyalty_points IS NULL` on a 999,000-rows-done,
  1,000-rows-left table would need to scan most of the table on every
  single batch to find the few remaining candidates.

## Tradeoffs

- **The batched version is slower in total wall-clock time than the naive
  one - 64.2s vs. 5.5s for the identical million rows, in this lab's own
  measurement.** This is the deliberate trade: total throughput for
  concurrency safety. A production backfill usually has hours or days to
  finish, not milliseconds - trading 12x total duration for 80x less impact
  on live traffic is almost always the right trade, but it IS a real cost,
  not a free lunch.
- **A fixed `sleepMs` is not adaptive.** It paces the backfill the same way
  regardless of whether the database is idle at 3am or under peak load at
  9am. A more sophisticated version would poll `pg_stat_activity` for
  active query count, watch its own p99 write latency, or (in a replicated
  setup) poll replication lag and back off when it grows - CLAUDE.md's
  "start with the simplest direct path" principle is why this lab does not
  build that; it is a documented, deliberate next step, not an oversight.
- **Batch size is a real tuning knob with real consequences in both
  directions.** Too large, and you're most of the way back to the naive
  scenario's blocking. Too small, and per-statement overhead (planning,
  network round trips, WAL flushes) dominates and total throughput drops
  much further than the concurrency benefit justifies.
- **A killed backfill leaves no record of WHY it stopped.** This lab's
  `WHERE loyalty_points IS NULL` predicate is enough to resume correctly,
  but a real operational backfill script usually also wants a persisted
  "cursor"/progress table so an operator can see "800,000 of 1,000,000
  done" without querying the target table directly, especially once the
  predicate itself becomes expensive to evaluate at very large scale.

## Production notes

1. **What guarantee does this technique provide?** Every row ends up with
   the correct backfilled value exactly once, and an interrupted run always
   resumes correctly with no operator intervention beyond "run the script
   again." Ordinary concurrent writes to the table are never blocked for
   longer than one batch's own short transaction.
2. **What does it not guarantee?** It does not guarantee the backfill
   finishes by any particular deadline - pacing trades speed for safety on
   purpose. It also does not protect against a DIFFERENT process
   concurrently writing `loyalty_points` itself (out of scope here - only
   this backfill ever touches that column in this lab).
3. **What breaks under process crash?** Nothing - see "Fix it" above. The
   only committed state that matters is which rows still have
   `loyalty_points IS NULL`, and that is durable in Postgres the instant
   each batch commits.
4. **What breaks under network partition?** Not applicable at this scale -
   single Postgres node, no replicas (see Lab 24+). In a replicated setup,
   a long naive transaction on the primary also delays WAL replay
   visibility on every replica for its whole duration, on top of the
   locking problem demonstrated here.
5. **What changes at high contention?** The naive scenario gets WORSE, not
   just slower - on a table with real production write traffic, its lock
   queue grows to include every session that touched any row it reached,
   compounding. The batched version's pacing matters more, not less, under
   contention: this is exactly when a fixed sleep should become an adaptive
   one (see "Tradeoffs").
6. **What changes with multiple regions?** Not applicable yet - this lab is
   single-node. In a multi-region deployment, a large backfill's WAL volume
   also has to replicate to every region, so pacing has to account for the
   slowest region's replay capacity, not just the primary's own load.
7. **What metrics would you monitor?** Rows remaining (`COUNT(*) WHERE
   loyalty_points IS NULL`, ideally via the partial index so the count
   itself stays cheap), rows/second (this lab's own `rowsPerSecond`), p99
   latency of ordinary queries against the target table during the run, and
   `pg_stat_activity`/`pg_locks` for anything unexpectedly waiting on the
   backfill's batches.
8. **What simpler alternative could be used?** If the table is small enough
   that a single `UPDATE` finishes in well under a second (as Lab 29's
   500-row table did), just run it - batching exists specifically to solve
   a problem that does not exist at small scale. Don't add machinery a
   dataset doesn't need.
9. **When should you avoid this technique?** Don't run a single
   unbatched `UPDATE` against any table with live read/write traffic once
   it's large enough that the statement takes more than a few hundred
   milliseconds - check with `EXPLAIN` or a dry-run count first, not after
   an incident.

## Interview questions

1. Why does a single `UPDATE` statement block a completely unrelated write
   to a row it has ALREADY finished updating, until the whole statement
   commits - what does that imply about how Postgres releases row locks?
2. Walk through why `WHERE loyalty_points IS NULL` makes a batched backfill
   naturally resumable, without any separate "progress" table or explicit
   checkpointing.
3. Why is the batched backfill in this lab's own measurement SLOWER in
   total wall-clock time than the naive one, and why is that an acceptable,
   even desirable, trade in production?
4. What is the difference between "killing a process" and "killing a
   process tree," and why did that distinction matter for this lab's own
   interruption demo?
5. A batched backfill's `sleepMs` is fixed. What real production signal
   would you want it to react to instead, and why?
6. How does one long-running transaction affect table bloat in tables it
   never even writes to? (Hint: think about what `VACUUM` needs to know
   before it can remove a dead tuple.)
7. Why does the partial index `WHERE loyalty_points IS NULL` matter more as
   the backfill progresses, rather than less?

## Further experiments

- Lower `scenario:batched`'s `--batch-size` and raise `--sleep-ms` and watch
  `rowsPerSecond` drop - find the point where per-batch overhead starts to
  dominate rather than concurrency safety.
- Run `scenario:naive` against `--size=medium` (200,000 rows) instead of
  `large` and compare the blocked-write latency and total duration - both
  should scale down roughly proportionally with row count.
- Change `interrupted-resume-backfill.ts`'s `killAfterMs` to something very
  small (e.g. 50ms, before even the first batch can commit) and confirm the
  script's own warning about "killed before its first batch committed"
  fires, then confirm the resume run still correctly backfills all rows
  from scratch.
- Add a dedicated `backfill_progress` table (one row, updated once per
  batch with `rows_done`/`total_rows`/`updated_at`) and compare how much
  cheaper it makes progress-reporting than repeatedly running `COUNT(*)
  WHERE loyalty_points IS NULL` once the pending cohort is very small
  relative to total table size, even with the partial index.
- Try making the naive scenario's target row the LAST id instead of the
  first, and predict (then verify) how that changes when, relative to the
  giant UPDATE's start, the ordinary write actually becomes blocked.
