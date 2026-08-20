# Lab 08 - Repeatable Read and Snapshots

## Why this exists

Lab 07 showed that Postgres's default isolation level, Read Committed, gives
each *statement* inside a transaction a fresh snapshot - so two identical
`SELECT`s in the same open transaction can disagree if someone else committed
a change in between. Repeatable Read is the natural next question: what if a
transaction needs its reads to agree with each other for its whole duration?

Repeatable Read answers that by taking exactly ONE snapshot, at the start of
the transaction, and reusing it for every statement. That fixes the
non-repeatable read. It also changes what happens when two transactions race
to write the same row: instead of silently letting the second commit
overwrite the first's intent, Postgres detects the conflict and aborts one
of them. Both of those are genuine, useful guarantees.

But Repeatable Read has a well-documented blind spot, and this lab exists
specifically to make you hit it: it does **not** protect an invariant that
spans two *different* rows. Two concurrent transactions can each read a
different row, each act on a perfectly valid (if temporarily stale)
snapshot, each write to their own row, and both commit successfully - while
the invariant your application cares about ends up violated. This anomaly is
called **write skew**, and it is the reason Lab 09 exists: only Serializable
isolation (via Serializable Snapshot Isolation) detects it.

## Learning objectives

After this lab you should be able to:

- explain precisely what Repeatable Read guarantees (one snapshot for the
  whole transaction) versus what Read Committed guarantees (a fresh snapshot
  per statement - Lab 07), and reproduce the difference on the exact same
  scenario under both levels;
- reproduce, against a real running Postgres instance, the fact that two
  Repeatable Read transactions racing to `UPDATE` the same row do not
  silently lose an update - Postgres rolls one of them back with
  `SQLSTATE 40001` ("could not serialize access due to concurrent update");
- reproduce write skew: two Repeatable Read transactions, each individually
  correct given its own snapshot, that both commit and jointly violate a
  cross-row invariant;
- explain precisely why Repeatable Read catches the same-row case but not
  the cross-row case - the row-version check that produces `40001` only
  fires when a transaction tries to write a row that changed since its
  snapshot; write skew never touches the same row twice;
- know the two ways to actually prevent write skew: application-level
  `SELECT ... FOR UPDATE` locking (works today, at Repeatable Read), or
  upgrading to Serializable isolation (Lab 09, the systemic fix).

## Architecture

```text
┌───────────────────────────┐         ┌──────────────────────┐
│ src/scenarios/             │         │                      │
│ repeatable-read-snapshot   │────────▶│                      │
│ (two pg.Client connections,│         │      PostgreSQL      │◀── pgweb
│  raw BEGIN/SET/COMMIT)     │────────▶│  (accounts,          │    (browser UI)
├────────────────────────────┤         │   on_call_staff)     │
│ concurrent-write-conflict  │────────▶│                      │
│ write-skew                 │────────▶│                      │
└────────────────────────────┘         └──────────────────────┘
                                                   ▲
                                            seed.ts / migrate.ts
```

Two small, purpose-built tables:

- `accounts` - a fresh copy of Lab 07's minimal banking-flavored table
  (labs are independent; this lab does not import Lab 07's schema, client,
  or scenario code). Backs `repeatable-read-snapshot.ts` and
  `concurrent-write-conflict.ts`.
- `on_call_staff` - the domain for the write-skew scenario: a small set of
  staff rows with an `is_on_call` boolean. The invariant "at least one row
  has `is_on_call = true`" spans multiple rows, so it cannot be expressed as
  a `CHECK` constraint on a single row - which is exactly what makes it
  vulnerable to write skew.

Every scenario uses two independent `pg.Client` connections driven with raw
SQL (`BEGIN`, `SET TRANSACTION ISOLATION LEVEL ...`, `COMMIT`), never
Drizzle's query builder - see `src/scenarios/support.ts`. Per CLAUDE.md's
"ORM plus SQL" rule, an interleaved multi-transaction experiment needs
explicit control over exactly when each statement fires, which a query
builder does not model.

## Setup

```bash
pnpm install
cp labs/08-repeatable-read-and-snapshots/.env.example labs/08-repeatable-read-and-snapshots/.env
cd labs/08-repeatable-read-and-snapshots
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate
pnpm seed
```

Open PGweb at http://localhost:8408 (it auto-connects via
`PGWEB_DATABASE_URL`). You should see an `accounts` table with 2 fixed
"Scenario Account - ..." rows plus a handful of faker-generated "browsing"
accounts, and an `on_call_staff` table with 2 fixed "Scenario Staff - ..."
rows plus a handful of faker-generated "browsing" staff.

## Scenario

Three independent experiments, in increasing order of surprise:

1. **Snapshot behavior.** A transaction reads a row twice, with another
   transaction's committed update happening in between. Does the second
   read see the update?
2. **Same-row conflict.** Two transactions each read a row, then each try to
   write a new value derived from what they read. Does Postgres let the
   second commit silently overwrite the first's intent?
3. **Write skew.** Two on-call doctors. The rule: at least one must stay on
   call. Two transactions each independently check "is my colleague on
   call?", and if so, decide it's safe for *them* to go off call. Both
   check, both decide yes, both go off call.

## Prediction

Before running anything, predict:

1. Transaction A begins with `REPEATABLE READ` and reads account X's
   balance. Transaction B updates and commits that same row. Does A's next
   read (same still-open transaction) see A's original balance or B's
   updated balance? How does this differ from Lab 07's Read Committed
   result on the identical setup?
2. Transaction A and Transaction B, both `REPEATABLE READ`, both read the
   same row's balance, then both try to `UPDATE` it based on what they
   read. A commits first. What happens when B tries to commit - does B's
   write silently apply, silently get lost, or does B's `UPDATE`/`COMMIT`
   fail with an error?
3. Two on-call doctors, both currently on call. Transaction A checks "is
   Dr. B on call?" (yes) and decides to take Dr. A off call. Transaction B,
   concurrently, checks "is Dr. A on call?" (yes, from B's own snapshot) and
   decides to take Dr. B off call. Do both transactions commit? If so, how
   many doctors are on call afterward?

## Exercise

1. Run the setup commands above.
2. Run `pnpm scenario:repeatable-read-snapshot` and read the log output -
   compare `firstRead` and `secondRead`: under `REPEATABLE READ` they are
   now IDENTICAL, unlike Lab 07's Read Committed result on the same setup.
3. Run `pnpm scenario:concurrent-write-conflict` and read the log output -
   transaction A's `UPDATE`+`COMMIT` succeeds, transaction B's `UPDATE`
   fails with `bErrorCode: "40001"`.
4. Run `pnpm scenario:write-skew` and read the log output - both
   transactions commit (`aCommitted: true`, `bCommitted: true`), yet
   `finalOnCallCount` is `0`.
5. Run `pnpm test` and read the assertions - they check actual values
   observed (including the write-skew test's deliberately unusual assertion
   that the *bad* outcome occurred), not timing or ordering.

## Observe

- **PGweb** (http://localhost:8408): browse `accounts` and `on_call_staff`
  after each scenario run and watch the rows settle at their post-scenario
  values.
- **`docker compose logs postgres`**: with `log_statement=all`, you can see
  the exact `BEGIN`, `SET TRANSACTION ISOLATION LEVEL ...`, `SELECT`,
  `UPDATE`, and `COMMIT` statements each scenario sent, interleaved between
  connections by timestamp.
- **`SHOW transaction_isolation`**: `repeatable-read-snapshot.ts` logs this
  immediately after `BEGIN` for both the `REPEATABLE READ` and
  `READ COMMITTED` runs its tests exercise.
- **Structured logs**: every scenario logs through `@labs/logging` (Pino),
  including `accountId`/`staffAId`/`staffBId`, the exact values read, the
  Postgres error code when one occurs (`bErrorCode`), and a final boolean
  verdict field (`secondReadMatchesFirstRead`, `bSawSerializationFailure`,
  `invariantViolated`).

## Break it

The "break" in this lab is the write-skew scenario succeeding when your
intuition says it shouldn't. Here is a real captured run
(`pnpm scenario:write-skew`):

```json
{"staffAId":"8","staffBId":"9","aSawBOnCallBeforeWriting":true,"bSawAOnCallBeforeWriting":true}
{"staffAId":"8","aWentOffCall":true}
{"staffBId":"9","bWentOffCall":true}
{"staffAId":"8","staffBId":"9","staffAName":"Scenario Staff - Dr. Alvarez","staffBName":"Scenario Staff - Dr. Boyko","aSawBOnCallBeforeWriting":true,"bSawAOnCallBeforeWriting":true,"aWentOffCall":true,"bWentOffCall":true,"aCommitted":true,"bCommitted":true,"finalOnCallCount":0,"invariantViolated":true}
```

Walk through why this happens:

1. Both transactions start `REPEATABLE READ` and take their snapshot before
   either writes anything.
2. Transaction A reads Dr. Boyko's row: `is_on_call = true`. From A's
   snapshot, this is completely accurate - it really was `true` when A's
   transaction began.
3. Transaction B reads Dr. Alvarez's row: `is_on_call = true`. Also
   completely accurate from B's snapshot.
4. A decides "someone else is covering, I can go off call" and updates
   *its own* row (Dr. Alvarez). B independently makes the identical
   decision and updates *its own* row (Dr. Boyko).
5. A commits. B commits. Neither transaction ever touched the row the other
   transaction wrote to, so there is no write-write conflict for Postgres's
   row-version check (the mechanism behind
   `concurrent-write-conflict.ts`'s `40001`) to catch.
6. Final state: both doctors are off call. The invariant "at least one
   doctor is on call" - which lives only in application logic, nowhere in
   the schema - is violated, even though every individual read was accurate
   and every individual write was valid.

This is not a bug in either transaction's code. Each transaction behaved
correctly *relative to the snapshot it was given*. The anomaly is a property
of the isolation level, not of the application logic.

## Fix it

There are exactly two ways to actually prevent this, and one non-fix worth
naming:

- **Not a fix: `CHECK` or `NOT NULL` on `on_call_staff`.** The invariant
  spans two rows. Postgres has no cross-row `CHECK` constraint mechanism (a
  trigger could enforce it, but at that point you have hand-rolled exactly
  the coordination logic described below, with none of the isolation-level
  precision).
- **Application-level fix, works today at Repeatable Read:
  `SELECT ... FOR UPDATE`.** Take a row lock on BOTH candidate rows before
  deciding:

  ```sql
  BEGIN;
  SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
  SELECT is_on_call FROM on_call_staff WHERE id IN (8, 9) ORDER BY id FOR UPDATE;
  -- now decide whether it's safe to go off call, using the locked values
  UPDATE on_call_staff SET is_on_call = false WHERE id = 8;
  COMMIT;
  ```

  Locking both rows (in a consistent order, to avoid deadlocks - see
  Lab 32) means the second transaction's `SELECT ... FOR UPDATE` blocks
  until the first transaction commits or rolls back, and then re-reads the
  now-current value - so it will correctly see the first doctor already off
  call and refuse to also go off call. This is Lab 10's subject in full.
- **Isolation-level fix, the systemic answer: Serializable (Lab 09).**
  Serializable Snapshot Isolation tracks read/write dependencies between
  concurrent transactions and detects the exact "dangerous structure" that
  write skew requires - two transactions where each has read something the
  other later wrote. One of the two transactions gets rolled back with a
  serialization failure at `COMMIT` time, and the application is expected
  to retry it. Lab 09 implements this scenario under `SERIALIZABLE` with a
  retry loop; `playground/notes.md` in this lab has a by-hand `psql`
  recipe to see the Serializable failure yourself before Lab 09 formalizes
  it.

The `SELECT ... FOR UPDATE` fix is preferable when you cannot or do not want
to raise the whole transaction's isolation level (Serializable has real
throughput costs under contention - see Tradeoffs). The Serializable fix is
preferable when the invariant is one of several, scattered across a
codebase, and you would rather rely on the database to catch violations
generically than hand-audit every code path for the rows it needs to lock.

## Why the fix works

`SELECT ... FOR UPDATE` works because it converts an implicit, invisible
dependency ("my decision depends on your row's value") into an explicit row
lock. The second transaction to reach the lock must wait for the first to
finish, and when it resumes, it reads current data - so its decision is no
longer based on data that is about to become stale. This is fundamentally
the same technique Lab 10 covers for the ordinary read-modify-write race;
write skew is just a two-row instance of that same class of problem.

Serializable works differently: it does not add locks up front. Instead, it
lets both transactions proceed exactly as under Repeatable Read, but tracks
which rows each transaction read and wrote. At commit time, if it finds a
cycle in the read/write dependency graph between concurrently-committing
transactions (transaction A read something B later wrote, and B read
something A later wrote - a "dangerous structure"), it aborts one of them
with a serialization failure. This is why Serializable transactions must
always be prepared to retry: the failure is discovered late, at commit, not
up front at lock-acquisition time like `FOR UPDATE`.

Repeatable Read's same-row `40001` (`concurrent-write-conflict.ts`) works by
a much simpler, narrower rule: an `UPDATE`/`DELETE` statement checks whether
the specific row it is about to change has a newer committed version than
the one visible in its own snapshot. That check is inherently single-row -
it has no way to know that a *different* row's concurrent update might
matter to your business logic. That narrowness is precisely the gap write
skew exploits.

See `docs/transaction-anomalies.md` for a cross-lab quick-reference on write
skew and the other anomalies Labs 06-09 cover.

## Tradeoffs

- **Repeatable Read's one-snapshot-per-transaction vs Read Committed's
  one-snapshot-per-statement**: Repeatable Read gives every statement in a
  transaction a mutually consistent view, at the cost of that view becoming
  stale as other transactions commit around it, and at the cost of the
  `40001` same-row conflict you must be prepared to retry (Read Committed
  never raises this error for a plain `UPDATE`, because it just re-reads
  fresh data per statement instead of erroring on staleness).
- **`SELECT ... FOR UPDATE` vs Serializable for write skew**: `FOR UPDATE`
  is cheaper (ordinary row locks, no dependency tracking) but requires you
  to identify, by hand, every row your invariant depends on, at every call
  site that could violate it - miss one, and the anomaly is back.
  Serializable requires zero per-invariant code changes, but adds
  dependency-tracking overhead to every transaction and forces every
  Serializable transaction, everywhere, to have retry logic, even ones that
  never touch the specific invariant you were worried about.
- **Two raw `pg.Client` connections vs one Drizzle transaction helper**:
  writing out `BEGIN` / `SET TRANSACTION ISOLATION LEVEL` / `COMMIT` by hand
  is more verbose than Drizzle's `db.transaction(async (tx) => ...)`, but it
  is the only way to control exactly when each of two independent
  transactions issues each statement - the interleaving order is the entire
  point of the experiment.

## Production notes

1. **What guarantee does this technique provide?** Repeatable Read
   guarantees every statement in a transaction sees one consistent
   snapshot taken at transaction start, and guarantees that a same-row
   read-modify-write race against a concurrently-committed change is
   detected (`40001`), never silently lost.
2. **What does it not guarantee?** It does not detect anomalies that span
   multiple rows guarded by an application-level invariant (write skew).
   It also does not eliminate the need for retry logic: any code path that
   can hit `40001` must be prepared to retry the whole transaction.
3. **What breaks under process crash?** Nothing new versus Lab 07 - an
   aborted transaction (whether by crash or by a `40001` rollback) simply
   never becomes visible. The risk is a crash happening *between* a
   `40001` and the application's retry, silently dropping the retry -
   that is an application bug, not a Postgres gap.
4. **What breaks under network partition?** Not applicable - single
   Postgres node, no replicas yet (see Lab 24+).
5. **What changes at high contention?** The rate of `40001` failures rises
   directly with how many concurrent transactions target overlapping rows
   under Repeatable Read. High contention means more retries, more wasted
   work re-executing transactions that get rolled back, and (for
   write-skew-shaped invariants specifically) a higher rate of undetected
   violations, since Repeatable Read never even signals a problem there.
6. **What changes with multiple regions?** Not applicable yet - see the
   replication labs (24-28). Cross-region write conflicts are a much harder
   version of this same problem, generally not solved by isolation level
   alone.
7. **What metrics would you monitor?** Rate of `40001` (serialization
   failure) errors per transaction type, and retry counts/latency added by
   retry loops. Write skew itself does not produce an error to monitor -
   which is exactly why it is dangerous; you would only notice it through a
   data-integrity check on the invariant itself (e.g. a periodic query
   asserting `count(*) FILTER (WHERE is_on_call) >= 1`).
8. **What simpler alternative could be used?** If the invariant only ever
   needs to be checked by a single writer at a time (e.g. a background job
   with no concurrent writers), you do not need any of this - the anomaly
   requires genuine concurrency to manifest.
9. **When should you avoid this technique?** Avoid relying on Repeatable
   Read alone whenever a business invariant spans more than one row and
   more than one code path can modify the rows involved. Use `SELECT ...
   FOR UPDATE` on the specific rows the invariant depends on, or move the
   whole transaction to Serializable (Lab 09) with retry logic.

## Interview questions

1. What exactly changes between Read Committed and Repeatable Read in terms
   of snapshot lifetime, and what specific class of bug does that fix?
2. Why does Repeatable Read raise `40001` for two transactions racing to
   update the SAME row, but not for the on-call-doctors scenario where they
   update DIFFERENT rows?
3. Is write skew a bug in Postgres? Defend your answer using the SQL
   standard's definition of Repeatable Read.
4. Give a second, non-medical example of a cross-row invariant vulnerable
   to write skew (hint: think about inventory, seating, or budget
   approval).
5. Why is `SELECT ... FOR UPDATE` a valid fix for write skew at Repeatable
   Read, when a plain `SELECT` is not?
6. What does an application have to do differently to safely use
   Serializable isolation that it does not have to do at Repeatable Read?
7. Why can't a `CHECK` constraint enforce "at least one row in this table
   has this flag set to true"?

## Further experiments

- In `src/scenarios/repeatable-read-snapshot.ts`, change the requested
  isolation level to `SERIALIZABLE` and confirm the second read still
  matches the first (Serializable also takes one snapshot per transaction,
  same as Repeatable Read, for plain reads).
- In `src/scenarios/write-skew.ts`, change the account names to a third
  pair of staff and add a THIRD concurrent transaction that also checks and
  decides - confirm that as long as at least one of the three transactions
  observes a still-on-call colleague AFTER the others have committed
  off-call, the anomaly does not occur; it only requires two transactions
  whose reads happen to interleave before any writes land.
- Rewrite `write-skew.ts`'s two transactions to use
  `SELECT ... FOR UPDATE` (see `playground/notes.md`) and confirm the
  second transaction now blocks and correctly refuses to go off call.
- Follow `playground/notes.md`'s by-hand `psql` recipe to reproduce this
  exact write-skew scenario under `SERIALIZABLE` and see the
  `could not serialize access due to read/write dependencies among
  transactions` error Lab 09 formalizes.
- Change `A_CREDIT_CENTS` / `B_DEBIT_CENTS` in
  `concurrent-write-conflict.ts` and rerun - confirm the specific amounts
  logged always match what you set, since none of the assertions hardcode
  the amounts.

## Real validation run (captured output)

The following are actual values captured from a real run against this lab's
Docker Compose stack (not hypothetical/aspirational output).

**`pnpm scenario:repeatable-read-snapshot`:**

```json
{"accountId":"8","requestedIsolationLevel":"REPEATABLE READ","actualIsolationLevel":"repeatable read"}
{"accountId":"8","firstRead":2000000}
{"accountId":"8","committedBalanceCents":2025000}
{"accountId":"8","secondRead":2000000}
{"secondReadMatchesFirstRead":true,"secondReadMatchesCommittedValue":false}
```

Note `secondRead` (`2000000`) equals `firstRead` (`2000000`), NOT
`committedBalanceCents` (`2025000`) - the direct contrast with Lab 07's
Read Committed result on the same setup, where the second read would show
`2025000`.

**`pnpm scenario:concurrent-write-conflict`:**

```json
{"accountId":"9","aRead":500000,"bRead":500000}
{"accountId":"9","aNewBalance":510000}
{"accountId":"9","bErrorCode":"40001","bErrorMessage":"could not serialize access due to concurrent update"}
{"aCommitted":true,"bFailed":true,"bSawSerializationFailure":true,"finalBalanceCents":510000,"finalBalanceMatchesA":true}
```

**`pnpm scenario:write-skew`:**

```json
{"staffAId":"8","staffBId":"9","aSawBOnCallBeforeWriting":true,"bSawAOnCallBeforeWriting":true}
{"staffAId":"8","aWentOffCall":true}
{"staffBId":"9","bWentOffCall":true}
{"aCommitted":true,"bCommitted":true,"finalOnCallCount":0,"invariantViolated":true}
```

`pnpm test` (3 files, 4 tests) and `pnpm typecheck` both pass cleanly
against this output. A full `docker compose down -v` followed by
`docker compose up -d`, `pnpm db:migrate`, `pnpm seed`, and `pnpm test` was
also run to confirm the reset flow reproduces identical results from a
clean database.
