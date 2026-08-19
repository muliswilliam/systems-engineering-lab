# Lab 05 - Transactions and Atomicity

## Why this exists

Every one of Labs 01-04 wrote one row at a time. Real systems routinely need
two or more writes to succeed or fail *together* - the textbook case is a
money transfer: debit one account, credit another. If those two writes are
issued as two independent SQL statements and the process dies, loses its
connection, or throws between them, Postgres has already durably committed
the first one. There is no "undo" - the debit happened, the credit didn't,
and the total amount of money in the system is now wrong. This lab makes
that failure happen on purpose, on a real Postgres instance, with a real
measured number of vanished cents - and then fixes it with the mechanism
Postgres has built in for exactly this problem: wrapping both statements in
one transaction (`BEGIN` ... `COMMIT`), so a failure anywhere before `COMMIT`
triggers a `ROLLBACK` that undoes everything since `BEGIN`, leaving no
partial state visible to anyone.

## Learning objectives

After this lab you should be able to:

- explain, precisely, why two bare SQL statements (no explicit
  `BEGIN`/`COMMIT`) are each their own independent, already-committed unit of
  work under Postgres's autocommit behavior - and why that makes a
  multi-statement operation non-atomic by default;
- explain what `BEGIN`, `COMMIT`, and `ROLLBACK` actually guarantee: every
  statement issued on a connection between `BEGIN` and `COMMIT` becomes
  durable together, or (if anything fails first) `ROLLBACK` undoes all of
  them, as if none had ever run;
- distinguish a *single-row* invariant (a `CHECK` constraint, which Postgres
  enforces per-statement regardless of transactions) from a *multi-statement*
  invariant (which only a transaction boundary can protect);
- point to the exact place in this lab's own code where an injected failure
  causes real, observable corruption in the naive version and real,
  observable safety in the transactional version - not a theoretical
  description, a captured before/after run (see "Break it" / "Fix it");
- explain why an audit row inserted *inside* a transaction that later rolls
  back does not survive the rollback, and why recording a failed attempt
  therefore requires a second, separate statement issued after `ROLLBACK`.

## Architecture

```text
accounts (id, public_id, owner_name, balance_cents CHECK >= 0, currency)
   ▲                              ▲
   │ from_account_id              │ to_account_id
   └──────────── transfers (audit trail of every transfer ATTEMPT) ────────┘
                  (public_id, amount_cents, mechanism, status, failure_reason)
```

Domain: **banking/ledger** (SPEC.md 8.2's "Banking/Ledger" domain), new in
this lab - none of the existing domains (payroll, commerce) have
money-moving accounts. `accounts` is a shared, reusable generator
(`packages/data-generators/src/ledger.ts` - `generateAccounts`); `transfers`
is scenario-specific to this lab (an audit trail of transfer *attempts*, not
a generic reusable entity) and is defined only in this lab's schema.

`transfers.status` records what actually happened, not what was requested:

| status | meaning |
|---|---|
| `pending` | Transfer started, outcome unknown. For `mechanism = 'transactional'` this is always transient - it becomes `completed`, or the entire row (including this `pending` insert) is rolled back and never exists at all. For `mechanism = 'naive'`, a row stuck at `pending` forever **is** the corruption - the debit already committed and no code ran afterward to update it. |
| `completed` | Both the debit and the credit are durable. |
| `failed` | (`transactional` only) The transaction rolled back; **neither** the debit nor the credit is durable. Inserted as a *separate* statement after `ROLLBACK` - a row inserted inside the rolled-back transaction would itself have been undone. |

Two scenario scripts, both performing the identical transfer shape (debit
`fromAccountId`, credit `toAccountId`) with the identical failure-injection
point (right after the debit statement, right before the credit statement):

```text
src/scenarios/naive-transfer.ts         <- two independent statements, no transaction
src/scenarios/transactional-transfer.ts <- BEGIN ... COMMIT / ROLLBACK
src/scenarios/balance-utils.ts          <- shared total/account balance queries
```

Both use the raw `pg` `Pool`/`Client` directly for `BEGIN`/`COMMIT`/
`ROLLBACK` rather than Drizzle's query builder - per `CLAUDE.md`'s "ORM plus
SQL" principle, explicit transaction-boundary control is exactly the kind of
thing that should be shown as real SQL, not hidden behind an abstraction.
Schema definition and migrations still use Drizzle.

## Setup

```bash
pnpm install
cp labs/05-transactions-and-atomicity/.env.example labs/05-transactions-and-atomicity/.env
cd labs/05-transactions-and-atomicity
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate
pnpm seed --seed=42 --size=small   # 10 accounts, deterministic balances
```

Open PGweb at http://localhost:8405 (auto-connects via
`PGWEB_DATABASE_URL`). You should see 10 rows in `accounts` and an empty
`transfers` table until you run one of the scenario scripts below.

## Scenario

A small bank has 10 customer accounts. Money moves between them via
transfers. Every transfer is conceptually two writes: subtract from the
source account, add to the destination account. The one invariant that must
hold **no matter what** - no matter how many transfers succeed, fail, or are
interrupted mid-flight - is:

> The total balance across every account in the system never changes just
> because a transfer was attempted.

A successful transfer moves money from one place to another; it never
creates or destroys it. A *failed* transfer must move zero net money - not
"approximately zero," not "corrected later by a batch job," exactly zero.

## Prediction

Before running anything, predict:

1. If a transfer is written as two separate `UPDATE` statements with no
   `BEGIN`/`COMMIT` around them, and the process fails immediately after the
   first `UPDATE` commits, what happens to the total balance across all
   accounts? Does Postgres do anything to protect you here?
2. If the same two statements are wrapped in `BEGIN ... COMMIT`, and the
   same failure is injected at the same point, what happens to the total
   balance this time? What actually undoes the already-executed debit
   statement?
3. An account has a `CHECK (balance_cents >= 0)` constraint. If a transfer
   attempts to debit more than an account's balance, does that particular
   failure mode corrupt anything, even in the *naive*, non-transactional
   version? Why or why not?
4. Can an audit row recording a failed transfer be inserted *inside* the
   same transaction that gets rolled back for that failure? What would
   happen to it?

## Exercise

1. Run the setup commands above.
2. Run the naive scenario - a happy-path transfer, then one with a crash
   injected between the debit and the credit:
   ```bash
   pnpm scenario:naive
   ```
3. Run the transactional scenario - the identical happy path, then the
   identical injected crash, this time inside a transaction:
   ```bash
   pnpm scenario:transactional
   ```
4. Run `pnpm dev` and compare `totalBalanceCents` against what `pnpm seed`
   reported, and look at `transfersByOutcome` - you should see exactly one
   orphaned `{ mechanism: "naive", status: "pending" }` row and no orphaned
   `transactional`/`pending` rows anywhere.
5. Run `pnpm test` and read through `tests/integration/naive-transfer.test.ts`
   and `tests/integration/transactional-transfer.test.ts` - these assert the
   exact invariants described above as real, automated checks.

## Observe

- **PGweb** (http://localhost:8405): the `transfers` table after running
  both scenarios - filter/sort by `mechanism` and `status` and find the
  `naive` / `pending` row that never resolved.
- **`docker compose logs postgres`**: `log_statement=all` makes every
  literal `BEGIN`, `UPDATE`, `COMMIT`, and `ROLLBACK` visible - compare the
  statement sequence for `scenario:naive` (no `BEGIN`/`COMMIT` at all)
  against `scenario:transactional` (`BEGIN` ... `ROLLBACK` for the crash
  case).
- **Structured logs**: both scenario scripts log through `@labs/logging`
  (Pino) with `totalBefore`/`totalAfter`/`fromBefore`/`fromAfter`/
  `toBefore`/`toAfter` on every attempt, so the corruption (or lack of it) is
  a field in the log line, not something you have to compute by hand.
- **`SELECT * FROM transfers WHERE status = 'pending';`**: in production,
  this is exactly the query a reconciliation job would run to find
  interrupted naive-style transfers - a transfer stuck at `pending` past
  some age threshold is a real operational signal.

## Break it

Run:

```bash
pnpm scenario:naive
```

Real captured output from this lab's own validation run (seed 42,
`--size=small`, 10 accounts):

```text
--- 1. naive transfer, happy path (no injected failure) ---
happy path: total balance preserved (no crash occurred, so both statements ran)
  totalBefore: 24936589   totalAfter: 24936589

--- 2. naive transfer, crash injected between debit and credit ---
CORRUPTED: total balance across all accounts changed - money vanished
  transferId: 50           transferStatus: "pending"
  amountCents: 1000
  fromAccountId: 1         toAccountId: 2
  fromBalanceBefore: 2293113   fromBalanceAfter: 2292113   (debited - correct)
  toBalanceBefore: 1532517     toBalanceAfter: 1532517     (NOT credited - bug)
  totalBalanceBefore: 24936589
  totalBalanceAfter: 24935589
  moneyVanishedCents: 1000
```

$10.00 (`1000` cents) is gone. It was subtracted from account 1 - that
`UPDATE` was its own independent statement and committed the instant it
succeeded - and the injected failure ("simulated crash") happened before the
second `UPDATE` (crediting account 2) ever ran. Nothing rolled the debit
back, because nothing was watching for a rollback: there was no transaction.
The `transfers` row for this attempt is stuck at `status = 'pending'`
forever - no code ran after the injected failure to mark it any other way.

## Fix it

Run:

```bash
pnpm scenario:transactional
```

Real captured output, same dataset, same injected failure point:

```text
--- 1. transactional transfer, happy path (no injected failure) ---
happy path committed: source debited, destination credited, total preserved
  totalBefore: 24935589   totalAfter: 24935589

--- 2. transactional transfer, crash injected between debit and credit ---
PRESERVED: ROLLBACK undid the debit - total balance and both individual
balances are byte-for-byte unchanged
  committed: false         transferId: 53   (the separate 'failed' audit row)
  reason: "simulated crash after debit, before credit (transactional transfer)"
  totalBefore: 24935589    totalAfter: 24935589
  fromBefore: 2291113      fromAfter: 2291113   (unchanged)
  toBefore: 1533517        toAfter: 1533517     (unchanged)
```

Identical injected failure, identical code shape - the only difference is
`BEGIN` before the first statement and `ROLLBACK` in the `catch` block. The
debit `UPDATE` executed exactly the same as in the naive version, but it was
never durable on its own: it only becomes permanent at `COMMIT`, which never
ran. `ROLLBACK` discarded it, along with the `pending` transfer row inserted
at the start of the same transaction. The `transfers` table shows a `failed`
row instead - inserted by a *separate* statement issued after the rollback
completed (see `src/scenarios/transactional-transfer.ts`), since a row
written inside the rolled-back transaction would have been rolled back too.

`pnpm test` captures both the bug and the fix as real assertions, including
an invariant test that runs 30 transactional transfer attempts (roughly a
third deliberately "crashed") between two accounts and asserts the total
balance across both is byte-for-byte identical before and after - regardless
of exactly how many of the 30 attempts happened to fail:

```text
✓ tests/integration/transactional-transfer.test.ts (4 tests) 91ms
✓ tests/integration/naive-transfer.test.ts (3 tests) 50ms

Test Files  2 passed (2)
     Tests  7 passed (7)
```

## Why the fix works

A Postgres transaction makes a set of statements atomic: Postgres does not
make any of their effects visible to other connections, and does not make
any of them durable, until `COMMIT` succeeds. If the client disconnects, the
process crashes, or the application code explicitly issues `ROLLBACK`
(which is what a caught exception triggers here) at any point before
`COMMIT`, Postgres discards every change made on that connection since
`BEGIN` - it is exactly as if none of those statements had ever run. That is
what "atomic" means here: not "fast," not "safe from bad input," but "all or
nothing."

Compare that against the naive version: with no explicit `BEGIN`, Postgres
runs in autocommit mode, and *each individual statement* is its own
implicit transaction. The debit `UPDATE` is atomic **by itself** (it either
fully applies or fully doesn't - see the insufficient-funds test, where the
`CHECK` constraint rejects it outright with zero side effects), but nothing
ties that statement's fate to the credit `UPDATE`'s fate. They are two
separate all-or-nothing units, not one.

The `accounts_balance_cents_non_negative` `CHECK` constraint is a genuinely
useful, separate guarantee: it protects a *single row* from ever going
negative, in either version, with or without a surrounding transaction (see
the "insufficient funds" tests in both `naive-transfer.test.ts` and
`transactional-transfer.test.ts`). It has nothing to say about whether a
debit and its matching credit happen together - that is a *cross-statement*
invariant, and only a transaction boundary (or, in principle, doing both
updates as one single SQL statement) can protect it.

## Tradeoffs

- **Transactions have a cost, but it is not the point of this lab.** Holding
  a transaction open for longer (more statements, slower application logic
  in between) means holding whatever row locks it acquired for longer -
  Lab 10 covers exactly what that costs under contention. This lab's
  transactions are two `UPDATE`s and an `INSERT`, held open for a handful of
  milliseconds; the atomicity guarantee is essentially free at this scale.
- **A transaction protects atomicity, not business correctness.** Wrapping
  bad application logic in `BEGIN`/`COMMIT` does not make it correct - it
  only guarantees that whatever the logic does happens completely or not at
  all. If the logic itself debits the wrong account, the transaction commits
  that mistake just as atomically as a correct transfer.
- **Recording a failure requires a statement outside the failed
  transaction.** This lab's `failed` audit row is a real operational
  consequence of atomicity: you cannot log "this transaction failed" from
  inside the transaction that is about to disappear. The audit insert here
  runs on the same pooled connection immediately after `ROLLBACK`, as its
  own implicit transaction - a pattern worth recognizing, since it comes up
  again whenever a failure needs to be durably recorded (this is also a
  small preview of why Lab 16's transactional outbox exists: sometimes you
  need the failure/success record and a side effect to be atomic with each
  other too).
- **A "crash after `COMMIT`" is a different problem than a "crash before
  `COMMIT`."** This lab only injects the failure *before* `COMMIT`. A
  failure that happens after `COMMIT` succeeds but before the caller learns
  about it is not an atomicity problem - the transfer genuinely completed -
  it is a "did my write actually happen?" problem, which is what retries and
  idempotency (Lab 15) exist to solve, not more transactions.

## Production notes

1. **What guarantee does this technique provide?** All statements between
   `BEGIN` and a successful `COMMIT` become durable together, or (via
   `ROLLBACK`, explicit or from any error) none of them do. This lab's tests
   assert exactly this: after an injected failure, both account balances and
   the system-wide total are byte-for-byte unchanged.
2. **What does it not guarantee?** Business correctness of the statements
   themselves, isolation guarantees stronger than Read Committed (see Labs
   06-09), or that the *caller* learns the outcome (a `COMMIT` can succeed on
   the server while the acknowledgment is lost on the way back to the
   client - see Lab 15 on idempotency).
3. **What breaks under process crash?** Before `COMMIT`: nothing - Postgres
   itself notices the dropped connection and rolls back automatically
   (this lab's explicit `ROLLBACK` in the `catch` block does the identical
   thing on purpose, deterministically, so it can be tested). After
   `COMMIT`: the transfer is durable regardless of what the application
   process does next.
4. **What breaks under network partition?** Not applicable yet - single
   Postgres node, no replicas (see Lab 24+). A partition between the
   application and Postgres mid-transaction behaves the same as a process
   crash from Postgres's point of view: the connection drops, the
   uncommitted transaction is rolled back server-side.
5. **What changes at high contention?** This lab's transactions are short
   and touch two rows each; under many concurrent transfers touching the
   *same* accounts, row locks held between `BEGIN` and `COMMIT` (see Lab 10)
   become the bottleneck, not the atomicity mechanism itself.
6. **What changes with multiple regions?** Not applicable yet - all of this
   lab's guarantees are single-node. Cross-region transfers introduce
   distributed-transaction and network-partition problems this lab does not
   cover (see the replication and messaging phases).
7. **What metrics would you monitor?** Count and age of `transfers` rows
   stuck at `status = 'pending'` (should be ~0 for a correctly-transactional
   system; nonzero and growing is exactly this lab's naive bug happening in
   production), transaction duration/rollback rate, and
   `pg_stat_database.xact_rollback` vs `xact_commit`.
8. **What simpler alternative could be used?** For this specific two-row
   transfer, none - a transaction is already the simplest correct mechanism.
   For higher-throughput ledger systems, a common variant is a single
   `INSERT` of two balanced `ledger_entries` rows (debit + credit) inside one
   transaction, computing balances from the entry log instead of mutating a
   `balance_cents` column directly - still the same transactional-atomicity
   principle, applied to an append-only model instead of a mutable one.
9. **When should you avoid this technique?** Never avoid wrapping a
   multi-statement invariant in a transaction when the statements run
   against the same database - there is essentially no reason not to.
   Avoid *very long-running* transactions (batch jobs, slow application
   logic between statements) that hold locks or an open snapshot for a long
   time; break those into smaller transactions instead (see Lab 30 on
   large-table backfills).

## Interview questions

1. Why is a single bare `UPDATE` statement always atomic on its own, even
   with no `BEGIN`/`COMMIT` anywhere in sight? What does that *not* protect
   you from once you have two statements that must succeed together?
2. Walk through exactly what Postgres does, mechanically, when `ROLLBACK` is
   issued after two `UPDATE`s and an `INSERT` have run inside an open
   transaction.
3. Why can't the `failed` audit row in this lab be inserted from inside the
   same transaction that's about to roll back? What has to happen instead?
4. A `CHECK (balance_cents >= 0)` constraint exists on `accounts`. Does it
   protect against the money-vanishing bug this lab demonstrates? What
   specifically does it protect against instead?
5. What's the difference between a transaction failing *before* `COMMIT` and
   a caller never finding out whether a transaction that already committed
   succeeded? Which one does wrapping code in `BEGIN`/`COMMIT` solve, and
   which one needs idempotency instead?
6. If you inherited a codebase where a "transfer" function issued two
   separate ORM `.save()` calls with no explicit transaction, what's the
   first question you'd ask to size the blast radius of the bug this lab
   demonstrates?

## Further experiments

- Move the injected failure to *after* the credit statement instead of
  before it, in both scenarios - confirm the naive version's corruption
  disappears too (both statements ran; only their sequencing was unsafe, not
  their content).
- Add a third statement to the transactional transfer (e.g. inserting a
  second audit row) between the credit and `COMMIT`, and inject the failure
  there instead - confirm `ROLLBACK` still undoes everything, including the
  now-three statements.
- Increase `tests/integration/transactional-transfer.test.ts`'s invariant
  test to 300 attempts with a higher failure ratio, or run several instances
  of the naive scenario back-to-back and watch how many orphaned `pending`
  rows accumulate in PGweb.
- Try wrapping the *naive* transfer's two statements in a single SQL
  statement instead (e.g. a CTE that updates both rows in one `UPDATE ...
  FROM`) and see whether that alone restores atomicity without an explicit
  `BEGIN`/`COMMIT` - and think about why that trick doesn't generalize to
  arbitrary multi-statement application logic.
- Read `src/scenarios/transactional-transfer.ts`'s `catch` block closely and
  try triggering the *insufficient funds* `CHECK` violation instead of the
  simulated-crash `Error` - confirm the exact same `ROLLBACK` path handles
  both failure types identically, because Postgres transactions don't care
  *why* a statement failed, only *that* it did.
