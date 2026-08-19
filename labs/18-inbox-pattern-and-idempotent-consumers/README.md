# Lab 18 - Inbox Pattern and Idempotent Consumers

## Why this exists

Lab 17's outbox publishers claim rows with `FOR UPDATE SKIP LOCKED` and
deliberately get crashed mid-publish - and the lesson there is that once you
have crash recovery plus at-least-once delivery, a message being redelivered
is not a rare edge case, it is the expected, permanent shape of the system.
A publisher can commit its "mark as published" write, then crash before the
downstream consumer ever acknowledges receipt; the only safe thing left to
do on restart is republish, which means some consumer, somewhere, will
eventually receive the identical message twice. Nothing in Lab 17 - or in
any outbox/broker/queue design - can make that stop happening. What CAN
happen is on the receiving end: this lab builds the consumer-side inbox
pattern, so that a redelivered message's business effect (crediting an
account) is applied exactly once, no matter how many times the message
physically arrives, and no matter whether two copies of it arrive at
literally the same instant. This is the pattern that makes Lab 17's
inevitable duplicate deliveries harmless.

## Learning objectives

After this lab you should be able to:

- explain why "the same message delivered twice" is a normal, expected
  consequence of at-least-once delivery, not a bug in the sender;
- distinguish "has a dedup table" from "is actually safe under concurrency" -
  a `processed_messages` check that isn't atomic with the effect it guards
  is not a fix, it's a narrower race condition;
- explain precisely why `INSERT ... ON CONFLICT (message_id) DO NOTHING`
  inside the same transaction as the business effect is what makes the
  dedup decision and the effect indivisible, and why that indivisibility is
  enforced by Postgres, not by application code;
- point to a real, captured run where a naive consumer double-applies a
  redelivered message, a real captured run where a check-then-insert
  consumer STILL double-applies it under real concurrency despite having a
  dedup table, and a real captured run where the atomic version stays
  exactly-once under both sequential and concurrent redelivery.

## Architecture

```text
accounts (id, public_id, owner_name, balance_cents CHECK >= 0, currency)
   ▲
   │ account_id
   └── processed_messages (message_id PRIMARY KEY, account_id, amount_cents, processed_at)
```

Domain: **banking/ledger** (SPEC.md 8.2), a fresh independent copy of the
`accounts` shape Labs 05/07/08/10 also use - per the independent-labs
principle, no lab's `accounts` table is shared or imported by another lab.
`accounts` reuses the shared `generateAccounts` generator from
`packages/data-generators/src/ledger.ts`; `processed_messages` (the inbox /
dedup table this lab is actually about) is defined only here.

There is no real message broker. Per CLAUDE.md's infrastructure-minimalism
guidance and this lab's brief, "the incoming queue" is modeled as a plain
`CreditAppliedMessage` object (`messageId`, `accountId`, `amountCents`,
see `src/scenarios/message.ts`) handed directly to a consumer function -
redelivery is simulated by calling that consumer function again with the
identical `messageId`, sequentially or concurrently.

Three consumer implementations, all consuming the identical message shape:

```text
src/scenarios/naive-consumer.ts                   <- no dedup check at all
src/scenarios/racy-check-then-insert-consumer.ts  <- dedup check present, NOT atomic with the effect
src/scenarios/idempotent-consumer.ts              <- dedup check + effect, ONE transaction (the fix)
```

All three use the raw `pg` `Pool`/`Client` directly for `BEGIN`/`COMMIT`/
`ROLLBACK` and `INSERT ... ON CONFLICT`, rather than Drizzle's query
builder - per CLAUDE.md's "ORM plus SQL" principle, transaction boundaries
and conflict-resolution SQL are exactly what should be shown as real SQL.
Schema definition and migrations still use Drizzle.

## Setup

```bash
pnpm install
cp labs/18-inbox-pattern-and-idempotent-consumers/.env.example labs/18-inbox-pattern-and-idempotent-consumers/.env
cd labs/18-inbox-pattern-and-idempotent-consumers
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate
pnpm seed --seed=42 --size=small   # 10 accounts, deterministic balances
```

Open PGweb at http://localhost:8418 (auto-connects via
`PGWEB_DATABASE_URL`). You should see 10 rows in `accounts` and an empty
`processed_messages` table until you run one of the scenario scripts below.

## Scenario

A downstream consumer receives `CreditApplied` events from some upstream
system and applies each one to an account's balance. At-least-once delivery
means the exact same event, identified by its `messageId`, can arrive more
than once:

- **sequentially** - a retry because the sender never saw an
  acknowledgment;
- **concurrently** - two copies of the redelivered message processed by two
  workers (or two connections of the same worker pool) at the same instant,
  a real possibility once you have more than one consumer process.

The invariant that must hold regardless of how many times the message
physically arrives:

> One logical event applies its business effect exactly once.

## Prediction

Before running anything, predict:

1. If a consumer applies `UPDATE accounts SET balance_cents = balance_cents
   + $1` with no dedup check, and the identical message is delivered twice,
   what happens to the account balance?
2. If the consumer first runs `SELECT 1 FROM processed_messages WHERE
   message_id = $1`, and only applies the effect plus inserts into
   `processed_messages` when that check finds nothing - as three separate
   statements, not one transaction - is that consumer now safe against a
   sequential redelivery? Against a *concurrent* redelivery? Why might the
   two answers differ?
3. If the check, the insert, and the effect are wrapped in a single
   transaction using `INSERT ... ON CONFLICT (message_id) DO NOTHING`, what
   decides which of two concurrent deliveries "wins" - and is that decision
   made by your application code or by Postgres?
4. What SQLSTATE would you expect to see if two concurrent INSERTs raced
   for the same primary key with no `ON CONFLICT` clause at all?

## Exercise

1. Run the setup commands above.
2. Run the naive scenario - deliver one message, then redeliver the
   identical message a second time:
   ```bash
   pnpm scenario:naive
   ```
3. Run the racy scenario - deliver the identical message to two workers
   CONCURRENTLY, with an artificial 50ms delay between the dedup check and
   the effect (see "Break it" below for why the delay exists):
   ```bash
   pnpm scenario:racy
   ```
4. Run the fixed scenario - a sequential redelivery, then a 10-way
   concurrent redelivery of the identical message:
   ```bash
   pnpm scenario:idempotent
   ```
5. Run `pnpm dev` and inspect `processedMessageCount` alongside
   `totalBalanceCents`.
6. Run `pnpm test` and read through the three test files under
   `tests/integration/` - these assert the exact invariants above as real,
   automated checks, including one with 20 truly concurrent deliveries of
   the same message.

## Observe

- **PGweb** (http://localhost:8418): after running all three scenario
  scripts, browse `processed_messages` - notice there is still at most one
  row per `message_id`, even for the racy consumer's message. The dedup
  table's own uniqueness is intact in every scenario; only the naive and
  racy consumers' *account balances* are wrong.
- **`docker compose logs postgres`**: `log_statement=all` makes the literal
  `BEGIN`, `INSERT ... ON CONFLICT`, `UPDATE`, `COMMIT`, and `ROLLBACK`
  sequence visible - compare the naive consumer (no `BEGIN` at all) against
  the idempotent consumer's `BEGIN ... ROLLBACK` (duplicate) or
  `BEGIN ... COMMIT` (genuinely new) pairs.
- **Structured logs**: every scenario script logs
  `balanceBefore`/`balanceAfter`/`expectedIfExactlyOnce` through
  `@labs/logging` (Pino), so the overcharge (or lack of it) is a field in
  the log line, not something you compute by hand.
- **`SELECT count(*) FROM processed_messages WHERE message_id = $1;`**: run
  this after the racy scenario - it returns `1`, proving the dedup table
  itself never has a duplicate row, which is exactly why the bug is subtle:
  a quick glance at `processed_messages` looks completely healthy.

## Break it

Two distinct failure modes, per this lab's brief.

### 1. No dedup check at all

```bash
pnpm scenario:naive
```

Real captured output from this lab's own validation run (seed 42,
`--size=small`):

```text
--- delivering message (1st time) ---
  messageId: d9b14cb2-cd4b-44d2-b451-2dddd1be2d0a   accountId: 11   amountCents: 2500

--- REDELIVERING the identical message (2nd time) ---

BUG: the account was credited twice for one logical event - no dedup check exists
  balanceBefore: 2294113
  balanceAfterFirstDelivery:  2296613
  balanceAfterSecondDelivery: 2299113
  expectedIfExactlyOnce: 2296613
  actual: 2299113
  overchargedCents: 2500
```

The account was overcharged by exactly one extra `amountCents` (2500,
$25.00) - the second delivery is indistinguishable from a brand-new event
to this consumer, because nothing records that the first delivery ever
happened.

### 2. A dedup check that isn't atomic with the effect

```bash
pnpm scenario:racy
```

`src/scenarios/racy-check-then-insert-consumer.ts` DOES check
`processed_messages` first. Delivered **sequentially**, that check alone is
enough - the second delivery finds the row and skips (`tests/integration/racy-consumer.test.ts`'s
first test proves this passes). The bug only appears under **real
concurrency**: two workers process the identical redelivered message at the
same instant, over two separate connections. To make this reliably
observable rather than an intermittent flake (per CLAUDE.md's "delays only
when needed to make the race observable"), the scenario and the test both
insert a 50ms artificial delay between "checked, not found" and "apply the
effect" - this was sufficient to reproduce the race on every run measured
during this lab's validation, including the automated test.

Real captured output, same validation run:

```text
--- delivering the SAME message to two workers CONCURRENTLY, with a 50ms check-to-insert delay ---
  messageId: 9325ab3b-5216-438e-bde1-fb7d625ed847   accountId: 11   amountCents: 3000

BUG: both concurrent deliveries passed the 'not found' check and both applied the effect -
the dedup table's own unique constraint only stopped the second bookkeeping INSERT, not the double UPDATE
  resultA: { outcome: "applied",                       workerId: "worker-a" }
  resultB: { outcome: "applied-but-insert-conflicted",  workerId: "worker-b", pgErrorCode: "23505" }
  balanceBefore: 2299113
  balanceAfter:  2305113
  expectedIfExactlyOnce: 2302113
  overchargedCents: 3000
```

Both workers saw "not found" from the `SELECT` (neither had inserted yet),
both slept through the artificial delay, and both ran
`UPDATE accounts SET balance_cents = balance_cents + $1` - that statement
succeeds unconditionally for both workers, because nothing about it depends
on `processed_messages`. Only the *second* worker's own bookkeeping
`INSERT INTO processed_messages` then failed, with a real Postgres
`23505` (`unique_violation`) on the `message_id` primary key - but by then
the harmful effect had already committed. `processed_messages` still ends
up with exactly one row for this `message_id` (its own integrity is fine);
the account was still credited twice. `pnpm test`'s
`racy-consumer.test.ts` captures this as a real assertion, not a narrated
claim.

## Fix it

```bash
pnpm scenario:idempotent
```

`src/scenarios/idempotent-consumer.ts` puts the dedup check/insert and the
business effect inside ONE transaction:

```sql
BEGIN;
INSERT INTO processed_messages (message_id, account_id, amount_cents)
  VALUES ($1, $2, $3)
  ON CONFLICT (message_id) DO NOTHING;
-- 0 rows affected -> already processed: ROLLBACK immediately, skip
-- 1 row affected  -> genuinely new: apply the effect in the SAME transaction
UPDATE accounts SET balance_cents = balance_cents + $1 WHERE id = $2;
COMMIT;
```

Real captured output, same validation run:

```text
--- sequential redelivery ---
FIXED (sequential redelivery): the 2nd delivery was recognized as a duplicate and skipped - effect applied exactly once
  balanceBeforeSeq: 2305113
  seqFirst:  { outcome: "applied",   workerId: "worker-seq" }   balanceAfterSeqFirst:  2309113
  seqSecond: { outcome: "duplicate", workerId: "worker-seq" }   balanceAfterSeqSecond: 2309113

--- 10-way CONCURRENT redelivery of the identical message ---
FIXED (real concurrent redelivery): exactly 1 of N concurrent deliveries applied the effect -
Postgres's UNIQUE constraint decided, not application logic
  workerCount: 10   appliedCount: 1   duplicateCount: 9
  balanceBeforeConcurrent: 2309113
  balanceAfterConcurrent:  2313113
  expectedIfExactlyOnce:   2313113
```

`pnpm test`'s `idempotent-consumer.test.ts` runs the same shape at a higher
concurrency (20 truly concurrent deliveries via `@labs/test-utils`'s
`runConcurrently`, over 20 separate connections) and asserts
`appliedCount === 1` exactly - not "usually 1."

```text
✓ tests/integration/racy-consumer.test.ts (2 tests) 102ms
✓ tests/integration/idempotent-consumer.test.ts (2 tests) 51ms
✓ tests/integration/naive-consumer.test.ts (2 tests) 34ms

Test Files  3 passed (3)
     Tests  6 passed (6)
```

## Why the fix works

`INSERT ... ON CONFLICT (message_id) DO NOTHING` inside a transaction makes
"is this message new?" and "apply its effect" one indivisible unit, backed
by Postgres's own `message_id` PRIMARY KEY. When two concurrent
transactions both attempt to insert the same `message_id`, Postgres's
row-level conflict handling ensures only one of them can actually insert
the row; the loser's `INSERT ... ON CONFLICT DO NOTHING` resolves to zero
affected rows once the winner commits (the loser blocks briefly on the
uncommitted winner's row, exactly like any other unique-constraint
conflict) - it does not error, and it never sees "not found" the way the
racy consumer's separate `SELECT` did. The loser's transaction then
`ROLLBACK`s having done nothing at all - no `UPDATE` ever runs for it. The
winner's `UPDATE` runs and commits inside the same transaction as its
successful `INSERT`, so the effect and the dedup record become durable
together or not at all, the same "all or nothing" atomicity Lab 05
established for money transfers, applied here to a check-then-act decision
instead of two independent writes.

This is precisely what the racy consumer lacks: its `SELECT` and its later
`INSERT` are two separate statements with no lock or transaction tying
them together, so two concurrent callers can both legitimately observe
"not found" before either one writes anything. Presence of a unique
constraint on `processed_messages` did not fix that - it only guaranteed
the *bookkeeping table* itself couldn't end up with two rows for the same
message, which is a real but much weaker guarantee than "the effect happens
once."

## Tradeoffs

- **Every message write costs one extra `INSERT`.** The idempotent
  consumer's transaction is one more statement (and one more index entry,
  on `processed_messages`'s primary key) than the naive consumer's bare
  `UPDATE`. At this lab's scale that is invisible; at very high message
  volume it is a real, measurable cost - and still nearly always worth
  paying compared to a silently-wrong ledger.
- **`processed_messages` grows forever unless pruned.** A production inbox
  table needs a retention policy (e.g. delete rows older than the maximum
  plausible redelivery window) - this lab does not implement one, since
  demonstrating exactly-once application, not table maintenance, is the
  learning objective (see Lab 30/31 for backfill and bloat/vacuum
  concerns that would apply here at scale).
- **The dedup key must be a stable, unique property of the message
  itself**, not something the consumer invents per delivery attempt. If the
  upstream system generates a *new* `messageId` on every redelivery instead
  of reusing the original event's ID, this entire pattern is defeated - the
  dedup table would faithfully record every "new" ID as new, because
  logically, from its point of view, they are. See Lab 15's idempotency-key
  lab for the mirror-image failure on the producer side.
- **This protects one consumer's own effect, not cross-service
  exactly-once.** If applying the credit also needs to trigger some other
  side effect (e.g. a notification), that side effect needs its own
  idempotency story - wrapping it in the same Postgres transaction only
  helps if it, too, is a database write.

## Production notes

1. **What guarantee does this mechanism give?** A message whose
   `message_id` has already been recorded in `processed_messages` will
   never have its business effect applied again, including under real
   concurrent delivery of the identical message - enforced by Postgres's
   own primary-key conflict resolution, not by application-level
   check-then-act logic.
2. **What guarantee does it not give?** It says nothing about whether the
   *sender* generates a stable, reusable `message_id` per logical event (a
   producer bug that mints a fresh ID per retry defeats this pattern
   entirely), and nothing about ordering - two different messages for the
   same account can still be applied out of order if delivery is
   unordered.
3. **What breaks under process crash?** Before `COMMIT`: nothing durable
   changed, so a crash mid-transaction is equivalent to the message never
   having been processed - a later redelivery is handled normally. After
   `COMMIT`: the effect and the dedup record are both durable together;
   a crash after `COMMIT` but before the caller acknowledges is exactly the
   scenario this whole lab exists to make harmless.
4. **What breaks under network partition?** Not applicable at this lab's
   scale - single Postgres node, no replicas (see Lab 24+). A partition
   between the consumer process and Postgres mid-transaction behaves like a
   process crash from Postgres's point of view: the connection drops, the
   uncommitted transaction rolls back server-side.
5. **What changes at high contention?** If the *same* `message_id` is
   redelivered by many concurrent workers at once (this lab's 10- and
   20-way tests), all but one transaction briefly wait on the row-level
   primary-key conflict and then cleanly resolve to "duplicate" - this is
   healthy, bounded contention, not a deadlock risk, because every
   transaction here only ever touches one `processed_messages` row and one
   `accounts` row in the same order.
6. **What changes at larger scale?** `processed_messages` needs an index
   it already has for free (the primary key) plus a retention/pruning job;
   at very high message throughput, sharding the inbox table (e.g. by
   `account_id` or a hash of `message_id`) becomes a consideration the same
   way any high-write table does.
7. **What metrics would be monitored?** Rate of `outcome: "duplicate"`
   results (this is exactly the redelivery rate - a healthy, expected
   nonzero number, not an alarm by itself), `processed_messages` table
   growth/row count over time, and `pg_stat_database.xact_rollback` for
   this workload (every duplicate is one deliberate, expected rollback).
8. **When should you avoid this technique?** When the consumer's effect is
   naturally idempotent already (e.g. `SET status = 'shipped'` - applying
   it twice is harmless because it's not an increment), a dedup table adds
   cost without adding safety. It is essential specifically for
   non-idempotent effects like `balance_cents = balance_cents + $1`.

## Interview questions

1. Why does a consumer that checks `processed_messages` before applying an
   effect still have a bug, if the check and the effect are not in the same
   transaction? Walk through the exact interleaving that breaks it.
2. What specific Postgres mechanism makes `INSERT ... ON CONFLICT
   (message_id) DO NOTHING` safe under real concurrency, when a
   `SELECT`-then-`INSERT` pair is not?
3. In this lab's racy scenario, why does `processed_messages` end up with
   exactly one row for the doubly-applied message, while `accounts` ends up
   wrong? What does that tell you about the difference between "the dedup
   table is correct" and "the guarantee it was meant to provide holds"?
4. If the upstream publisher generated a brand-new `message_id` on every
   retry instead of reusing the original event's ID, would this lab's
   `idempotent-consumer.ts` still work? Why or why not?
5. Why would `SKIP LOCKED` be irrelevant to this specific lab's problem,
   even though it's central to Lab 14 and Lab 17?
6. How would you decide the retention window for `processed_messages` in a
   system where redeliveries can theoretically arrive days late?

## Further experiments

- Remove the `ON CONFLICT (message_id) DO NOTHING` clause from
  `idempotent-consumer.ts` entirely (a plain `INSERT`) and rerun the
  concurrent test - watch it fail with an uncaught `23505` from one of the
  N concurrent workers instead of a clean `"duplicate"` outcome, and think
  through why `ON CONFLICT` is what turns "an error to catch" into "an
  expected branch."
- In `racy-check-then-insert-consumer.ts`, set `delayMs` to `0` in `main()`
  and run `pnpm scenario:racy` several times - the race becomes
  intermittent instead of guaranteed, illustrating why the test file uses a
  deliberate delay rather than relying on natural scheduling.
- Increase `idempotent-consumer.test.ts`'s `WORKER_COUNT` from 20 to 100 or
  200 and confirm `appliedCount` is still always exactly 1.
- Add a `processed_messages` retention query (`DELETE FROM
  processed_messages WHERE processed_at < now() - interval '7 days'`) and
  think through what redelivery window would make it safe to run in a real
  system.
- Change the effect from an increment (`balance_cents = balance_cents +
  $1`) to a naturally idempotent effect (e.g. `SET currency = $1`) and
  observe that the naive consumer's "bug" disappears even without a dedup
  table - then explain in your own words why that does NOT mean dedup
  tables are unnecessary in general.
