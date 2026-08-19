# Lab 07 - Read Committed

## Why this exists

Lab 06 showed that Postgres's MVCC keeps multiple versions of a row around so
readers and writers rarely block each other. This lab answers the question
that raises immediately: if a transaction can be open for a while, and other
transactions keep committing changes underneath it, what exactly does *my*
transaction see, and when?

The honest answer for Postgres's default isolation level - Read Committed -
is uncomfortable the first time you see it: two identical `SELECT`s of the
same row, inside the same still-open transaction, can return two different
values, as long as someone else committed a change in between. That's not a
bug. It's the documented contract of Read Committed, and a huge amount of
application code is quietly relying on it without anyone having decided to.
This lab makes that behavior happen on purpose, and separately proves the one
thing Postgres never does at any isolation level: expose a write nobody has
committed yet.

## Learning objectives

After this lab you should be able to:

- explain precisely what "Read Committed" guarantees (each *statement* gets a
  fresh snapshot) versus what people often assume it guarantees (the whole
  *transaction* gets one snapshot - that's Repeatable Read, Lab 08);
- reproduce a non-repeatable read with two real, independently-controlled
  Postgres connections, not a thought experiment;
- state, and prove against a running Postgres instance, that dirty reads
  (reading another transaction's uncommitted write) cannot happen in
  Postgres at any isolation level;
- explain why `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED` is accepted
  syntax that changes nothing about observable behavior in Postgres, and why
  `SHOW transaction_isolation` echoing back "read uncommitted" is not proof
  of a real separate implementation;
- know when Read Committed is not enough, and which lab covers the fix
  (Lab 08's Repeatable Read snapshot, or Lab 10's `SELECT ... FOR UPDATE`).

## Architecture

```text
┌────────────────────┐         ┌──────────────────────┐
│ src/scenarios/      │         │                      │
│ dirty-read-attempt  │────────▶│                      │
│ (two pg.Client       │         │      PostgreSQL      │◀── pgweb
│  connections, raw    │────────▶│      (accounts)      │    (browser UI)
│  BEGIN/SET/COMMIT)   │         │                      │
├─────────────────────┤         │                      │
│ non-repeatable-read  │────────▶│                      │
│ read-uncommitted-vs- │────────▶│                      │
│ read-committed        │         └──────────────────────┘
└─────────────────────┘                    ▲
                                     seed.ts / migrate.ts
```

Domain: a minimal **banking/ledger**-flavored slice (SPEC.md ยง8.2) - a single
`accounts` table with a mutable `balance_cents` column. That is the smallest
possible domain that has a "same row, read twice" story, which is exactly
what isolation-level experiments need; there is no `transfers` or
`ledger_entries` table here because this lab is about isolation semantics,
not a rich relational model (Lab 09's Serializable lab is where a
multi-row invariant matters).

Every scenario uses two independent `pg.Client` connections driven with raw
SQL (`BEGIN`, `SET TRANSACTION ISOLATION LEVEL ...`, `COMMIT`), never
Drizzle's query builder - see `src/scenarios/support.ts`. Per CLAUDE.md's
"ORM plus SQL" rule, an interleaved two-transaction experiment needs explicit
control over exactly when each statement fires, which a query builder does
not model.

## Setup

```bash
pnpm install
cp labs/07-isolation-read-committed/.env.example labs/07-isolation-read-committed/.env
cd labs/07-isolation-read-committed
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate
pnpm seed
```

Open PGweb at http://localhost:8407 (it auto-connects via
`PGWEB_DATABASE_URL`). You should see an `accounts` table with 3 fixed
"Scenario Account - ..." rows plus a handful of faker-generated "browsing"
accounts.

## Scenario

A bank account has a balance. One transaction reads that balance - maybe to
show it on a dashboard, maybe as the first step of a multi-step business
operation. While that transaction is still open, another transaction debits
or credits the same account and commits. What does the first transaction see
if it reads the balance again before it commits or rolls back?

## Prediction

Before running anything, predict:

1. Transaction A starts, reads account X's balance, and does NOT commit. If
   transaction B updates the SAME row and commits while A is still open,
   does A's *next* read (same open transaction) see A's original balance or
   B's updated balance?
2. Transaction A updates a row but does not commit. Transaction B opens a
   transaction and explicitly requests `SET TRANSACTION ISOLATION LEVEL READ
   UNCOMMITTED`. Does B's read see A's uncommitted, in-flight value?
3. After requesting `READ UNCOMMITTED`, does `SHOW transaction_isolation`
   report `read committed` (because Postgres "corrects" it) or `read
   uncommitted` (because it just echoes back what you asked for)?

## Exercise

1. Run the setup commands above.
2. Run `pnpm scenario:non-repeatable-read` and read the log output - it logs
   transaction A's first read, transaction B's independent committed update,
   and transaction A's second read (same open transaction), so you can see
   the values change out from under A.
3. Run `pnpm scenario:dirty-read` and read the log output - transaction B
   explicitly requests `READ UNCOMMITTED` and still cannot see transaction
   A's uncommitted debit.
4. Run `pnpm scenario:isolation-equivalence` and compare the two runs it logs
   (one requesting `READ COMMITTED`, one requesting `READ UNCOMMITTED`) -
   note the `actualIsolationLevel` field differs between them (Postgres
   echoes back the label you asked for), but every read value is identical.
5. Run `pnpm test` and read the assertions - they check actual values read,
   not timing or ordering.

## Observe

- **PGweb** (http://localhost:8407): browse `accounts` after each scenario
  run and watch `balance_cents` settle at the post-scenario value for each
  "Scenario Account - ..." row.
- **`docker compose logs postgres`**: with `log_statement=all`, you can see
  the exact `BEGIN`, `SET TRANSACTION ISOLATION LEVEL ...`, `SELECT`,
  `UPDATE`, and `COMMIT` statements each scenario sent, interleaved between
  the two connections by timestamp.
- **`SHOW transaction_isolation`**: every scenario logs this immediately
  after `BEGIN` - watch it echo back `read uncommitted` even though the read
  behavior that follows is identical to `read committed`.
- **Structured logs**: every scenario logs through `@labs/logging` (Pino),
  including `accountId`, the exact balance values read, and a final boolean
  verdict field (`sawDirtyRead`, `readsDiffer`, `behaviorIsIdentical`).

## Break it

The "break" here is a naive mental model, not a bug: the assumption that a
transaction sees a single consistent snapshot of the database for its entire
duration. Read Committed does not provide that.

Run the non-repeatable-read scenario and look at a real captured run:

```text
transaction A: first read           accountId=26  firstRead=2000000
transaction B: BEGIN, UPDATE, COMMIT accountId=26  committedBalanceCents=2025000
transaction A: second read          accountId=26  secondRead=2025000
```

Transaction A never committed, never rolled back, and ran the exact same
`SELECT balance_cents FROM accounts WHERE id = $1` twice - and got `2000000`
the first time, `2025000` the second. If application code read a balance
once and reused that in-memory value later in the same transaction assuming
it couldn't have changed, that assumption is false under Read Committed.

Then run the dirty-read scenario and look at a real captured run:

```text
transaction A: debited but NOT committed   accountId=25  uncommittedBalanceCents=995000
transaction B: BEGIN READ UNCOMMITTED       requestedIsolationLevel="READ UNCOMMITTED"  actualIsolationLevel="read uncommitted"
transaction B: read while A uncommitted     balanceSeenWhileAUncommitted=1000000
transaction A: COMMIT
transaction B: read again (same open tx)    balanceSeenAfterACommit=995000
```

B explicitly asked for `READ UNCOMMITTED` - the isolation level whose entire
point, in databases that implement it, is "let me see uncommitted writes."
Postgres accepted the request without error (`actualIsolationLevel` even
echoes back `"read uncommitted"`) and then did not honor it: B's first read
returned `1000000` (the original, committed value), not `995000` (A's
in-flight, uncommitted debit). Only after A committed did B's *next* read
see `995000`. If you came from a database where `READ UNCOMMITTED` really
means "see everything, dirty or not," this is the surprise: Postgres's
MVCC-based storage engine has no code path that exposes an uncommitted tuple
to another transaction, at any isolation level - there was never a
"read uncommitted" implementation to select.

## Fix it

"Fixing" a non-repeatable read means picking the isolation level (or locking
strategy) that actually gives you the guarantee your code needs:

- If your code just needs each individual read to reflect committed data,
  Read Committed already gives you that - correctly reason about it as
  "read fresh every statement," not "snapshot once."
- If your code performs multiple reads in one transaction and needs them to
  agree with each other (e.g., compute a report from several queries that
  must reflect one consistent point in time), reach for **Repeatable Read**
  (Lab 08) - one snapshot for the whole transaction, so the second read in
  this lab's scenario would return the SAME value as the first.
- If your code reads a row specifically *in order to write it back*
  (read-modify-write), Repeatable Read still is not enough on its own to
  prevent a lost update in all cases - reach for **`SELECT ... FOR UPDATE`**
  (Lab 10) to take a row lock at read time, or a conditional write
  (`UPDATE ... WHERE version = ?`, Lab 11).

For the "dirty read" half of this lab, there is nothing to fix - Postgres
already refuses dirty reads unconditionally. The fix is entirely in the
mental model: never assume `READ UNCOMMITTED` buys you a performance
shortcut in Postgres by skipping consistency checks. It does not exist as a
distinct behavior here.

## Why the fix works

Read Committed's per-statement snapshot exists because Postgres's MVCC
storage keeps multiple versions of every row; a snapshot is just "the set of
already-committed row versions visible as of some point in time." Read
Committed takes a new snapshot at the start of *every statement* inside a
transaction, so a later statement can see commits that happened after the
transaction (but before that statement) began - that is the entire mechanism
behind the non-repeatable read demonstrated above. Repeatable Read instead
takes one snapshot at the start of the *transaction* and reuses it for every
statement, which is why it would not exhibit this behavior (Lab 08).

Dirty reads never happen because MVCC visibility rules are checked against a
row version's commit status, not against isolation level. A reader's
snapshot only ever includes tuples from transactions that had already
committed at snapshot-creation time - an in-flight, uncommitted `UPDATE`
simply has no committed tuple for anyone else's snapshot to include, no
matter what isolation level that snapshot was taken under. `READ UNCOMMITTED`
in the standard SQL sense would require a genuinely different, weaker
visibility rule; Postgres never implemented one, so it maps the requested
level onto the same Read Committed machinery (see
`src/scenarios/read-uncommitted-vs-read-committed.ts` for the direct A/B
comparison).

## Tradeoffs

- **Read Committed's per-statement snapshot vs Repeatable Read's per-transaction
  snapshot**: Read Committed lets each statement see the freshest committed
  data, which is usually what you want for independent reads and reduces the
  chance of serialization conflicts under contention. The cost is exactly
  the non-repeatable read this lab demonstrates - multiple statements in one
  transaction can disagree with each other.
- **Accepting `READ UNCOMMITTED` as valid syntax instead of rejecting it**:
  this is a portability tradeoff SQL standard databases make - accepting the
  keyword and mapping it to the nearest safe implementation means code
  written against another database's `READ UNCOMMITTED` doesn't fail to
  parse in Postgres. The cost is exactly the false expectation this lab
  exists to correct: the keyword is accepted but does not mean what it means
  elsewhere.
- **Two raw `pg.Client` connections vs one Drizzle transaction helper**:
  writing out `BEGIN` / `SET TRANSACTION ISOLATION LEVEL` / `COMMIT` by hand
  is more verbose than Drizzle's `db.transaction(async (tx) => ...)`, but it
  is the only way to control exactly when each of two independent
  transactions issues each statement - the interleaving order is the entire
  point of the experiment.

## Production notes

1. **What guarantee does this technique provide?** Read Committed guarantees
   every statement only sees data committed before that statement began, and
   Postgres guarantees no isolation level, ever, exposes an uncommitted
   write to another session.
2. **What does it not guarantee?** Read Committed does not guarantee that two
   statements in the same transaction agree with each other, and it does not
   prevent lost updates in a naive read-modify-write sequence (two
   transactions can both read the same "old" value, both compute a new value
   from it, and the second commit silently overwrites the first's intent -
   Lab 11 covers detecting and preventing this).
3. **What breaks under process crash?** Nothing new here - an open
   transaction that crashes without committing simply never becomes visible
   to anyone, consistent with "dirty reads never happen."
4. **What breaks under network partition?** Not applicable - single
   Postgres node, no replicas yet (see Lab 24+).
5. **What changes at high contention?** Read Committed's per-statement
   snapshot means readers essentially never block writers and vice versa
   (no locks are needed just to read); the cost shows up instead as
   surprising result changes between statements, which is a correctness risk
   under high write contention, not a throughput risk.
6. **What changes with multiple regions?** Not applicable yet - see the
   replication labs (24-28) for what "read committed" even means once reads
   can go to a replica with its own replication lag.
7. **What metrics would you monitor?** Not much specific to isolation level
   alone in production dashboards - but application bugs traceable to
   non-repeatable reads usually show up as intermittent, hard-to-reproduce
   data inconsistencies rather than as a metric; the fix is in code review
   and testing, not monitoring.
8. **What simpler alternative could be used?** If your code only ever does
   one read per transaction, Read Committed's behavior is invisible and
   there is nothing simpler to reach for. The complexity only shows up once
   a transaction needs multiple statements to agree.
9. **When should you avoid this technique?** Avoid relying on Read
   Committed when a transaction performs more than one read of the same
   logical data and requires those reads to be mutually consistent - use
   Repeatable Read or Serializable instead (Lab 08, Lab 09), or restructure
   to a single read at the top of the transaction.

## Interview questions

1. What exactly does "Read Committed" take a fresh snapshot of, and at what
   granularity - once per transaction, or once per statement?
2. Why can Postgres accept `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED`
   without ever exposing an uncommitted row?
3. If `SHOW transaction_isolation` reports `read uncommitted`, does that
   prove Postgres implements a distinct read-uncommitted isolation level?
   Why or why not?
4. Give a concrete application bug that a non-repeatable read under Read
   Committed could cause in a multi-step transaction.
5. Why doesn't a `CHECK` constraint or a foreign key help with the
   non-repeatable-read problem at all?
6. When would Repeatable Read be the wrong upgrade from Read Committed, and
   `SELECT ... FOR UPDATE` the right one instead?

## Further experiments

- In `src/scenarios/non-repeatable-read.ts`, change the requested isolation
  level to `REPEATABLE READ` (a level this lab's helper types don't restrict
  you from passing manually) and predict, then confirm, that `secondRead`
  now equals `firstRead` instead of the newly committed value - this is
  Lab 08's subject, previewed here.
- Add a third, concurrent transaction C that also reads the account between
  A's two reads, and confirm C sees whatever the most recently committed
  value is at the moment C's own statement runs - Read Committed's snapshot
  is per-statement, not shared across observers.
- Change `DEBIT_CENTS` / `CREDIT_CENTS` in the scenario files and rerun -
  confirm the specific dollar amounts logged always match what you set,
  since none of the assertions hardcode the amounts.
- Open two `psql "$DATABASE_URL"` sessions by hand (see `playground/notes.md`)
  and reproduce both scenarios manually, one statement at a time, to feel
  the interleaving instead of just reading the log output.

## Real validation run (captured output)

The following are actual values captured from a real run against this lab's
Docker Compose stack (not hypothetical/aspirational output):

**`pnpm scenario:dirty-read`:**

```json
{"accountId":"25","originalBalanceCents":1000000}
{"accountId":"25","uncommittedBalanceCents":995000}
{"requestedIsolationLevel":"READ UNCOMMITTED","actualIsolationLevel":"read uncommitted"}
{"balanceSeenWhileAUncommitted":1000000,"aStillUncommitted":995000}
{"balanceSeenAfterACommit":995000}
{"sawDirtyRead":false}
```

**`pnpm scenario:non-repeatable-read`:**

```json
{"accountId":"26","firstRead":2000000}
{"accountId":"26","committedBalanceCents":2025000}
{"accountId":"26","secondRead":2025000}
{"readsDiffer":true,"secondReadMatchesCommittedValue":true}
```

**`pnpm scenario:isolation-equivalence`:**

```json
{"requestedIsolationLevel":"READ COMMITTED","actualIsolationLevel":"read committed","firstRead":3000000,"secondRead":3025000}
{"requestedIsolationLevel":"READ UNCOMMITTED","actualIsolationLevel":"read uncommitted","firstRead":3000000,"secondRead":3025000}
{"behaviorIsIdentical":true}
```

`pnpm test` (6 tests across 3 files) and `pnpm typecheck` both pass cleanly
against this output.
