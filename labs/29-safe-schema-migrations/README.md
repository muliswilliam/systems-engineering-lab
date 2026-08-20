# Lab 29 - Safe Schema Migrations

## Why this exists

A schema migration is not a single atomic event from the application's point
of view. Postgres applies `ALTER TABLE customers RENAME COLUMN full_name TO
display_name` in milliseconds - but the fleet of application instances
reading and writing that table does not update in milliseconds. A rolling
deploy runs OLD and NEW code side by side for seconds to minutes while
instances cycle one at a time. If the database migration finishes before
every instance has been redeployed onto code that expects the new column
name, every remaining old instance's query breaks the instant the rename
commits - not gradually, not with a warning, immediately and completely. This
lab reproduces that incident for real, on a real Postgres instance, with a
real captured `42703` error - then fixes it with the pattern CLAUDE.md's
"Safe Migrations" section requires: expand/contract, so the schema and the
application code are never required to change in the same instant. It also
covers the two other classic "the migration looks hung" incidents: a plain
`CREATE INDEX` that blocks writes for as long as some other transaction holds
the table, and an `ALTER TABLE` that queues up indefinitely behind a
conflicting lock unless `lock_timeout` tells it to fail fast instead.

## Learning objectives

After this lab you should be able to:

- explain precisely why renaming a column is dangerous during a rolling
  deploy, and reproduce the exact Postgres error (`42703`, "column ... does
  not exist") old code hits the instant the rename commits;
- walk through every phase of expand/contract - add column, dual write,
  batched backfill, read-path switch - and explain why each phase is
  individually safe even though the sequence as a whole changes which column
  the application reads from;
- explain why `ALTER TABLE ... ADD COLUMN ... text` (nullable, no default) is
  a near-instant, pure-catalog change regardless of table size, and why that
  specific property is what makes it safe to run against a live table;
- explain why a plain `CREATE INDEX` blocks concurrent writers for as long as
  any transaction holds a conflicting lock on the table, and why `CREATE
  INDEX CONCURRENTLY` does not - at the cost of taking longer and being able
  to fail into an `INVALID` index that needs manual cleanup;
- explain why an `ALTER TABLE` with no `lock_timeout` can appear to "hang" in
  production (it hasn't hung - it's queued behind a lock, and every other
  query on that table is now queuing up behind it), and how `SET
  lock_timeout` turns that into a fast, safe failure instead.

## Architecture

```text
customers (id, public_id, full_name, display_name [migration 0001], email, country, created_at)
```

Domain: commerce-adjacent `customers`, reusing the shape of the shared
`generateCustomers` generator from `packages/data-generators/src/commerce.ts`
(publicId/fullName/email/country) - a fresh, independent table defined only
in this lab (no import from Lab 03/04's own `customers` table, per the
independent-labs principle).

**Design choice - what is Drizzle-tracked vs. raw SQL, and why:**

| Change | How it's applied | Why |
|---|---|---|
| `customers` baseline (`full_name`, `email`, `country`, ...) | Drizzle migration `0000_*.sql` | This lab's real, steady-state schema. |
| `ADD COLUMN display_name text` (nullable) | Drizzle migration `0001_*.sql`, also re-issued idempotently (`ADD COLUMN IF NOT EXISTS`) by `expand-contract-migration.ts` phase (a) | This is the one *safe* DDL change this lab performs - CLAUDE.md explicitly calls out favoring Drizzle migrations for the safe/expand steps of a schema evolution. Re-running it from the script is deliberately idempotent so the script is runnable on its own or after `db:migrate`, and either way you see the real, measured, near-instant duration. |
| `RENAME COLUMN full_name TO display_name` (the dangerous migration) | Raw SQL, `naive-rename-breaks-old-code.ts`, against a throwaway copy of the table | This is a deliberately dangerous, one-off manual operation being demonstrated as an *incident*, not this lab's steady-state schema - it must never be part of the tracked migration history a learner would actually apply. See "Break it" for why it runs against a scratch copy. |
| `CREATE INDEX` / `CREATE INDEX CONCURRENTLY` on `customers(country)` | Raw SQL, `concurrent-index-vs-blocking.ts` | A one-off operational DDL statement, not a schema shape Drizzle needs to know about for this lab's purposes - CLAUDE.md calls out `CREATE INDEX CONCURRENTLY` specifically as SQL that should stay raw and visible. |
| `ALTER TABLE ... ADD COLUMN demo_col text` with/without `lock_timeout` | Raw SQL, `lock-timeout-fail-fast.ts`, columns added and dropped within the same run | A throwaway demonstration column, not part of the lab's real schema - added and cleaned up so the script is safe to rerun. |

`schema.ts` therefore reflects the **final, safe state this lab's own
runnable scope reaches**: both `full_name` and `display_name` present,
`display_name` correctly populated for every row (via dual write or
backfill). Actually dropping `full_name` - the "contract" step's last move -
is explicitly out of this lab's runnable scope; see "Fix it" phase (e).

Four independent scenario scripts:

```text
src/scenarios/naive-rename-breaks-old-code.ts   <- the incident (raw SQL, scratch table)
src/scenarios/expand-contract-migration.ts      <- the fix (phases a-d)
src/scenarios/concurrent-index-vs-blocking.ts   <- plain vs. CONCURRENTLY
src/scenarios/lock-timeout-fail-fast.ts         <- lock_timeout fail-fast
src/scenarios/lock-helpers.ts                   <- shared "hold a write lock" helper
```

All four use the raw `pg` `Client`/`Pool` directly for `BEGIN`/DDL/lock
control, per CLAUDE.md's "ORM plus SQL" principle - migrations and
type-safe queries elsewhere in the lab still go through Drizzle.

## Setup

```bash
pnpm install
cp labs/29-safe-schema-migrations/.env.example labs/29-safe-schema-migrations/.env
cd labs/29-safe-schema-migrations
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate
pnpm seed --seed=42 --size=small   # 500 customers, deterministic
```

Open PGweb at http://localhost:8429 (auto-connects via
`PGWEB_DATABASE_URL`). You should see 500 rows in `customers`, all with
`display_name` still `NULL` - that's the pre-migration cohort every scenario
in this lab works against.

## Scenario

A commerce application has a `customers` table with a `full_name` column.
Product wants to rename it to `display_name` (a more accurate name now that
the field is also used for guest checkouts without a "full legal name"). The
application is deployed as a rolling fleet of instances - at any given
moment during a deploy, some instances are running old code and some are
running new code. The database is a single, shared resource that both
generations of code read and write simultaneously.

## Prediction

Before running anything, predict:

1. If a migration tool runs `ALTER TABLE customers RENAME COLUMN full_name
   TO display_name` and old application instances are still issuing `SELECT
   full_name FROM customers`, what error do they get, and how soon after the
   migration commits does it start happening?
2. Is `ALTER TABLE customers ADD COLUMN display_name text` (no default, no
   `NOT NULL`) fast or slow on a table with 500 rows? What about 500 million
   rows? Why?
3. If Transaction A holds an open transaction that has written to
   `customers`, and Transaction B then issues a plain `CREATE INDEX ON
   customers (country)`, does B have to wait for A? Does `CREATE INDEX
   CONCURRENTLY` change that answer?
4. If Transaction A holds a conflicting lock on `customers` and Transaction B
   issues `ALTER TABLE customers ADD COLUMN ...` with no `lock_timeout` set,
   how long does B wait? What happens to a third session that just wants to
   `SELECT` from `customers` while B is waiting?

## Exercise

1. Run the setup commands above.
2. Run the dangerous migration and watch it break old code on purpose:
   ```bash
   pnpm scenario:naive-rename
   ```
3. Run the safe fix, phase by phase:
   ```bash
   pnpm scenario:expand-contract
   ```
4. Run the index-locking race:
   ```bash
   pnpm scenario:concurrent-index
   ```
5. Run the lock-timeout race:
   ```bash
   pnpm scenario:lock-timeout
   ```
6. Run `pnpm test` and read through `tests/integration/*.test.ts` - these
   assert the exact invariants described above as real, automated checks.

## Observe

- **PGweb** (http://localhost:8429): after `scenario:naive-rename`, browse
  `customers_naive_demo` - a scratch table with `display_name` where
  `full_name` used to be. After `scenario:expand-contract`, browse
  `customers` and confirm every row now has a non-`NULL` `display_name`.
- **`docker compose logs postgres`**: `log_statement=all` and
  `log_lock_waits=on` make every `ALTER TABLE`, `BEGIN`/`COMMIT`, `CREATE
  INDEX [CONCURRENTLY]`, and lock wait visible in order.
- **Structured logs**: every scenario logs through `@labs/logging` (Pino)
  with real captured durations, error codes, and row/batch counts on every
  step - not just a final pass/fail.
- **`SELECT * FROM pg_locks WHERE relation = 'customers'::regclass;`**: run
  this from a third `psql` session while `scenario:lock-timeout` or
  `scenario:concurrent-index` is executing to see the actual lock modes
  (`ShareLock`, `ShareUpdateExclusiveLock`, `AccessExclusiveLock`) held and
  waited on in real time.

## Break it

Run:

```bash
pnpm scenario:naive-rename
```

Real captured output from this lab's own validation run:

```text
old application code: SELECT full_name succeeds before the migration runs
  customerId: 501   fullName: "Garnet Reynolds-Miller"

MIGRATION COMMITTED: full_name renamed to display_name - old application
instances have NOT been redeployed yet
  customerId: 501

INCIDENT: old application code's query failed the instant the rename committed
  customerId: 501
  sqlState: "42703"
  message: "column \"full_name\" does not exist"

new application code (reading display_name) would have worked fine all along
- it just hasn't been deployed everywhere yet
  customerId: 501   displayName: "Garnet Reynolds-Miller"
```

This is a real, reproduced production incident: a genuine `ALTER TABLE ...
RENAME COLUMN`, committed on a real Postgres instance, followed by a genuine
old-code query that fails with SQLSTATE `42703`. The demo runs against
`customers_naive_demo`, a throwaway copy of `customers` created fresh by the
script (`CREATE TABLE customers_naive_demo AS SELECT ... FROM customers`) -
purely so this lab's other scenarios, seed data, and tests (which all share
the real `customers` table) stay repeatable and unaffected by a deliberately
dangerous, real DDL statement. In a real incident there is, of course, no
scratch copy - this IS the production table, and the rename really does
commit against it.

Notice the data was never lost or corrupted - `display_name` (the renamed
column) holds the exact same value `full_name` did. The only thing broken is
that old code doesn't know the column has a new name. That's the whole
lesson: a rename is data-safe and application-breaking at the same time.

## Fix it

Run:

```bash
pnpm scenario:expand-contract
```

Real captured output, same dataset (500 seeded customers, all with
`display_name IS NULL`):

```text
rows predating this migration (display_name IS NULL): 500

phase (a) EXPAND: ALTER TABLE ADD COLUMN display_name text (nullable)
  durationMs: 1.19

phase (b): dual write (simulating newly deployed compatible application code)
  inserted a new customer through dual-write code - both columns set together
  newCustomer: { id: 1001, publicId: "40536001-..." }

phase (c): backfill existing rows written before dual-write code went live
  batch 1: rowsInBatch 200   rowsBackfilled 200
  batch 2: rowsInBatch 200   rowsBackfilled 400
  batch 3: rowsInBatch 100   rowsBackfilled 500
  backfill complete: batches 3, rowsBackfilled 500

phase (d): read-path switch - new code reads display_name for both cohorts
  pre-existing (backfilled) row:  customerId 501  fullName "Garnet Reynolds-Miller"  displayName "Garnet Reynolds-Miller"  correct: true
  newly dual-written row:         customerId 1001 displayName "Priya Desai"          correct: true
```

Phase (a) took **1.19ms** for a 500-row table - the same statement would take
a comparable few milliseconds against a 500-million-row table, because
Postgres does not touch a single existing row to add a nullable column with
no default; it is a pure catalog metadata change. Phase (c)'s backfill moved
all 500 rows in **3 batches of 200/200/100** (a deliberately small batch size
of 200 to make the multi-batch behavior visible at this dataset size) rather
than one giant `UPDATE` - per CLAUDE.md, "large backfills must be batched and
resumable." It genuinely is resumable: the `WHERE display_name IS NULL`
clause means rerunning the function after an interruption only touches rows
that still need it (see `tests/integration/expand-contract.test.ts`'s
resumability test, which seeds a row with a sentinel value and proves a
rerun does not re-touch it).

`pnpm test` captures both the incident and the fix as real assertions:

```text
✓ tests/integration/expand-contract.test.ts (5 tests)
✓ tests/integration/naive-rename.test.ts (3 tests)
✓ tests/integration/concurrent-index-vs-blocking.test.ts (2 tests)
✓ tests/integration/lock-timeout.test.ts (2 tests)

Test Files  4 passed (4)
     Tests  12 passed (12)
```

**Phase (e) - stopping writes to `full_name` and eventually dropping it - is
deliberately not implemented in this lab.** It is a later migration, run only
once every application instance in the fleet is confirmed to be running code
that no longer reads or writes `full_name` at all. Dropping a column too
early is exactly as dangerous as the naive rename this lab opened with - the
only genuinely safe order is: expand, deploy dual-write code everywhere,
backfill, deploy read-switch code everywhere, confirm 100% rollout, *then*
contract.

### CREATE INDEX vs. CREATE INDEX CONCURRENTLY

Run:

```bash
pnpm scenario:concurrent-index
```

Real captured output (a transaction holds a write lock on `customers` for
2000ms in both races):

```text
race 1: plain CREATE INDEX vs. a held write-locking transaction
  plain CREATE INDEX returned only after the blocking transaction committed
  createIndexDurationMs: 1956.98   holdMs: 2000

race 2: CREATE INDEX CONCURRENTLY vs. the identical held transaction
  third-party write against an unrelated row succeeded WHILE CREATE INDEX
  CONCURRENTLY was still building
    thirdWriteCustomerId: 502   thirdWriteDurationMs: 3.00
  CREATE INDEX CONCURRENTLY finished without ever blocking ordinary writes
    createIndexConcurrentlyDurationMs: 1960.38   holdMs: 2000
```

The plain `CREATE INDEX` needed **1957ms** to return - it could not even
start building until the 2000ms-held transaction released its `ROW
EXCLUSIVE` lock, because `CREATE INDEX` requires a `SHARE` lock, and `SHARE`
conflicts with `ROW EXCLUSIVE`. Every other write against `customers` during
that window would have queued up behind the waiting `CREATE INDEX` too.

`CREATE INDEX CONCURRENTLY` took about the same wall-clock time overall
(**1960ms** - it still has to wait for the older transaction's snapshot to
finish before it can safely validate the new index), but a completely
unrelated write from a **third** connection, issued while both the holder
transaction and the concurrent index build were in flight, completed in
**3ms** - it was never blocked by either of them. That's the property that
matters: `CONCURRENTLY` takes a `SHARE UPDATE EXCLUSIVE` lock, which does not
conflict with the `ROW EXCLUSIVE` lock ordinary writes take.

### `lock_timeout`: fail fast instead of hanging

Run:

```bash
pnpm scenario:lock-timeout
```

Real captured output (a transaction holds a conflicting lock for 1500ms in
both runs):

```text
run 1: ALTER TABLE with NO lock_timeout - blocks for the full hold duration
  ALTER TABLE (no lock_timeout) blocked until the conflicting lock was
  released, then succeeded
    durationMs: 1454.34   succeeded: true

run 2: ALTER TABLE with SET lock_timeout - fails fast instead of hanging
  MIGRATION FAILED FAST: lock_timeout fired before the conflicting lock was
  released
    durationMs: 506.52   succeeded: false
    errorCode: "55P03"   errorMessage: "canceling statement due to lock timeout"
```

With no `lock_timeout` set, the `ALTER TABLE` waited **1454ms** - essentially
the entire duration of the held lock - before it could acquire the `ACCESS
EXCLUSIVE` lock it needs and succeed. With `SET lock_timeout = '500ms'` set
first, the identical `ALTER TABLE` against the identical held lock failed
after **507ms** with a real Postgres error: SQLSTATE `55P03`, "canceling
statement due to lock timeout." This is the fix for the real, common
production incident where a migration appears to "hang": it isn't hung, it's
queued behind a lock, and every other query on that table is now queuing up
behind IT, because `ACCESS EXCLUSIVE` conflicts with every other lock mode,
including a plain `SELECT`'s `ACCESS SHARE`.

## Why the fix works

Every phase of expand/contract is individually safe because it never
requires the schema and every instance of the application to change
atomically together:

- **Expand** (`ADD COLUMN display_name`, nullable) is additive - old code
  that has never heard of `display_name` keeps working exactly as before,
  because it never queries a column it doesn't know about.
- **Dual write** makes new code forward- and backward-compatible: it writes
  both columns, so a read from either column is correct for any row written
  after this code deployed, regardless of which generation of code performs
  that read.
- **Backfill** closes the only remaining gap - rows written *before*
  dual-write code existed, which have `full_name` but not yet
  `display_name`. Doing this in small batches means each individual
  transaction is short-lived (locks a handful of rows briefly, not the whole
  table for the whole backfill), and the `WHERE display_name IS NULL`
  predicate makes the whole operation naturally resumable.
- **Read-path switch** only happens once every row - old and new - has a
  correct `display_name`, so it is safe regardless of which rows happen to
  get read first.

Contrast that with the naive rename: it changes the schema in a single
instant that has no relationship to the application's own deploy timeline.
There is no way to sequence "deploy the last old instance" and "run this
migration" safely relative to each other with a single atomic rename -
expand/contract exists specifically to remove that ordering dependency.

`CREATE INDEX CONCURRENTLY` and `lock_timeout` work for a related but
distinct reason: they change *which lock is taken* and *how long the caller
is willing to wait for one*, respectively - neither one changes the
migration's actual schema effect, only its blast radius against concurrent
traffic.

See `docs/lock-reference.md` for a cross-lab quick-reference on the
table-level lock modes `CREATE INDEX`/`ALTER TABLE` take.

## Tradeoffs

- **Expand/contract takes longer and needs more deploys than a single
  rename.** It trades a single fast (but dangerous) DDL statement for
  several genuinely safe ones spread across a real rollout timeline - this
  is a deliberate trade of migration speed for zero-downtime safety.
- **Dual-write code is temporary complexity you must remember to remove.**
  Every write path has to know about both columns for as long as any old
  code might still be reading `full_name` - this is exactly why phase (e)
  (stop writing the old column, then drop it) is a real, necessary step, not
  an optional cleanup.
- **`CREATE INDEX CONCURRENTLY` can fail into an `INVALID` index.** If it's
  interrupted (killed, connection lost) partway through, Postgres does not
  retry it - it leaves an index marked `INVALID` in `pg_index` that must be
  dropped and rebuilt by hand (`DROP INDEX CONCURRENTLY` also avoids
  blocking, unlike a plain `DROP INDEX`). It also cannot run inside an
  explicit transaction block.
- **A short `lock_timeout` trades "guaranteed eventual success" for "fast,
  visible failure."** A migration that fails fast still has to run again
  later - `lock_timeout` doesn't make contention go away, it just refuses to
  let one migration silently become the reason an entire table's traffic
  stalls.

## Production notes

1. **What guarantee does this technique provide?** Expand/contract
   guarantees the schema is never in a state that only one generation of
   application code can correctly use - both old and new code remain
   correct for the entire rollout window. `CREATE INDEX CONCURRENTLY` and
   `lock_timeout` guarantee that a DDL operation's cost is paid in *time*
   rather than in *blocked concurrent traffic*.
2. **What does it not guarantee?** Expand/contract does not make the
   application code changes themselves correct - a dual-write bug still
   corrupts data, just more slowly and in both columns. `lock_timeout` does
   not guarantee the migration eventually succeeds; a retry loop or a
   maintenance window is still needed under sustained contention.
3. **What breaks under process crash?** A crash mid-backfill leaves some
   rows with `display_name IS NULL` and some without - safely resumable,
   because the backfill's own `WHERE` clause is the only state it needs. A
   crash mid-`CREATE INDEX CONCURRENTLY` leaves an `INVALID` index that must
   be manually dropped and rebuilt.
4. **What breaks under network partition?** Not applicable at this scale -
   single Postgres node, no replicas (see Lab 24+). In a replicated setup,
   every DDL statement here also has to replay on every replica, and a
   long-held lock on the primary can contribute to replica apply lag.
5. **What changes at high contention?** A plain `CREATE INDEX` or an
   `ALTER TABLE` with no `lock_timeout` on a busy production table can queue
   for minutes, not milliseconds, behind a long-running report query or a
   forgotten open transaction - and every subsequent query on that table
   queues up behind it in turn, which is why `lock_timeout` (and monitoring
   `pg_locks`/`pg_stat_activity` for waiting DDL) matters far more at scale
   than in this lab's small, quiet dataset.
6. **What changes with multiple regions?** Not applicable yet - this lab is
   single-node. A multi-region deployment adds the requirement that the
   *rollout itself* (not just the migration) must tolerate old and new code
   coexisting for however long it takes every region to finish deploying,
   which can be much longer than a single-region rollout.
7. **What metrics would you monitor?** `pg_stat_activity` for
   long-running/blocked DDL, `pg_locks` for lock-wait chains, backfill
   progress (rows remaining `WHERE display_name IS NULL`), and
   `pg_stat_user_indexes`/`pg_index.indisvalid` for a `CREATE INDEX
   CONCURRENTLY` that may have failed into an invalid state.
8. **What simpler alternative could be used?** For a column that will
   always be nullable and rarely queried, sometimes it's simpler to just
   leave the old name and give the application-level field a different
   display name in code - "safe migration" is not free, and not every rename
   is worth the expand/contract machinery.
9. **When should you avoid this technique?** Don't use a bare `RENAME
   COLUMN`/`DROP COLUMN` against any table a live application queries during
   a rolling deploy - full stop. Don't run a plain `CREATE INDEX` or an
   `ALTER TABLE` with no `lock_timeout` against a table with meaningful write
   traffic without first checking `pg_stat_activity` for long-running
   transactions that would turn it into an incident.

## Interview questions

1. Why does a column rename break old application code immediately, with no
   gradual degradation - what does that imply about how you sequence a
   migration relative to a rolling deploy?
2. Why is `ALTER TABLE ... ADD COLUMN foo text` (nullable, no default) fast
   regardless of table size, while `ADD COLUMN foo text NOT NULL DEFAULT
   'x'` used to (and, depending on the value/type, sometimes still can)
   require a full table rewrite?
3. Walk through why a backfill has to be batched instead of one giant
   `UPDATE`, and explain in what sense the batched version is "resumable."
4. What specific lock does a plain `CREATE INDEX` take, and why does that
   make it conflict with an open write transaction? What lock does `CREATE
   INDEX CONCURRENTLY` take instead, and why doesn't that lock conflict with
   ordinary writes?
5. A migration has been running for 10 minutes and looks "stuck." What is
   the very first thing you'd check in Postgres, and what would `SET
   lock_timeout` have done differently if it had been set beforehand?
6. Why is dropping the old column ("contract") a separate migration run
   later, rather than part of the same deploy that adds the new column and
   switches reads?

## Further experiments

- Change `scenario:naive-rename` to run the `RENAME COLUMN` inside an open
  transaction on one connection while a *different* connection tries to read
  `full_name` - confirm the second connection still sees the old schema
  until the first connection commits (ordinary MVCC/DDL visibility), then
  breaks the instant it does.
- Reduce `expand-contract-migration.ts`'s backfill `batchSize` from 200 to
  25 against `--size=large` (5,000 rows) and watch the batch count and log
  volume scale accordingly.
- Try adding a `NOT NULL` constraint to `display_name` after the backfill
  completes using `ALTER TABLE ... ADD CONSTRAINT ... CHECK (display_name IS
  NOT NULL) NOT VALID` followed by a separate `VALIDATE CONSTRAINT` - compare
  the lock behavior of `NOT VALID` + `VALIDATE CONSTRAINT` against a plain
  `ALTER COLUMN ... SET NOT NULL`.
- Kill (`Ctrl+C`) a `CREATE INDEX CONCURRENTLY` mid-build and inspect
  `SELECT indexrelid::regclass, indisvalid FROM pg_index WHERE NOT
  indisvalid;` - confirm you now have to `DROP INDEX` it by hand.
- Lower `lock-timeout-fail-fast.ts`'s `lockTimeoutMs` to something very
  small (e.g. 10ms) and confirm it can now fail even against a very briefly
  held lock - then raise the holder's `holdMs` and confirm the
  no-`lock_timeout` run's duration tracks it linearly.
