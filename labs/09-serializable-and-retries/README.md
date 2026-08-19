# Lab 09 - Serializable and Retry Loops

## Why this exists

Lab 08 (Repeatable Read) showed that Postgres's snapshot isolation stops two
transactions from clobbering each other's write to the *same row*, but does
nothing about two transactions that each read a *different* row, each
correctly conclude "my change is safe given what I just read", and then both
write - creating an outcome that violates a business invariant even though
neither transaction, read in isolation, did anything wrong. That anomaly is
called **write skew**, and no amount of per-row locking or `CHECK` constraint
can prevent it, because the invariant it violates spans multiple rows.

This lab reproduces write skew for real, then shows the one isolation level
that actually detects it - **Serializable** - and proves the corollary
CLAUDE.md insists on: Serializable is not "free correctness". Postgres gives
you the guarantee by aborting one of the conflicting transactions with a real
error (SQLSTATE `40001`), which means your application code MUST catch that
error and retry, or the guarantee is worthless. This lab builds, and load
tests, that retry loop.

## Learning objectives

After this lab you should be able to:

- explain precisely what write skew is and why it is invisible to Repeatable
  Read (Postgres's snapshot isolation only detects write-write conflicts on
  the same row, not the rw-antidependency cycle that write skew requires);
- reproduce write skew against a real running Postgres instance with two
  independently-controlled transactions, not a thought experiment;
- explain how Serializable Snapshot Isolation (SSI) detects a "dangerous
  structure" (a cycle of rw-antidependencies between concurrent
  transactions) and state exactly which SQLSTATE it raises (`40001`) and
  when (at the commit, or first statement after the conflict becomes
  unavoidable, of the transaction Postgres chooses to abort);
- write a bounded retry loop around a Serializable transaction that
  re-reads fresh state on every attempt instead of replaying a stale
  decision, and that treats "the invariant now forbids this" as a
  legitimate terminal outcome, not a bug;
- measure, not just assert, the contention cost Serializable adds under
  concurrent load, and use that measurement to explain why Serializable is
  not the universal default isolation level.

## Architecture

```text
┌───────────────────────────┐        ┌──────────────────────┐
│ src/scenarios/             │        │                      │
│ write-skew-under-           │───────▶│                      │
│ repeatable-read             │───────▶│                      │◀── pgweb
│ serializable-detects-       │───────▶│      PostgreSQL      │    (browser UI)
│ conflict                    │───────▶│   (on_call_staff)    │
│ serializable-with-retry     │───────▶│                      │
│ contention-and-throughput   │───────▶│                      │
└───────────────────────────┘        └──────────────────────┘
                                                 ▲
                                          seed.ts / migrate.ts
```

Domain: **on-call staff** (SPEC.md Lab 09's own suggested domain) - a single
`on_call_staff` table (`team`, `name`, `is_on_call`). The business invariant
is "every team must have at least one member on call at all times". That
invariant spans multiple rows (the whole team), so it is deliberately **not**
expressed as a `CHECK` constraint - see `src/db/schema.ts` for why a
row-level `CHECK` cannot express it at all.

Every scenario uses raw `pg.Client` connections driven with raw SQL (`BEGIN`,
`SET TRANSACTION ISOLATION LEVEL ...`, `COMMIT`), never Drizzle's query
builder - see `src/scenarios/support.ts`. Per CLAUDE.md's "ORM plus SQL"
rule, this lab's entire subject is the exact interleaving of two or more
transactions and the exact error Postgres raises, which a query builder does
not model.

This lab's schema and scenarios are defined entirely under
`labs/09-serializable-and-retries/` and do not import anything from Lab 08 or
any other lab, per the independent-labs principle - even though the
underlying anomaly (write skew) and the illustrative domain (on-call staff)
are the same ones Lab 08 previews.

## Setup

```bash
pnpm install
cp labs/09-serializable-and-retries/.env.example labs/09-serializable-and-retries/.env
cd labs/09-serializable-and-retries
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate
pnpm seed
```

Open PGweb at http://localhost:8409 (it auto-connects via
`PGWEB_DATABASE_URL`). You should see an `on_call_staff` table with 7 fixed
"scenario" rows (2 on the write-skew team, 5 on the contention team) plus a
handful of faker-generated "browsing" rows on unrelated teams.

## Scenario

A hospital's ER night shift has two doctors on call: Alice and Bob. Hospital
policy: at least one doctor must always be reachable. Both doctors, at
roughly the same moment, check the on-call board and think "my colleague is
still on call, so it's fine if I clock out." Both clock out. Now zero doctors
are on call - the exact catastrophic outcome the policy exists to prevent -
even though each doctor's individual decision was correct given what they
observed at the moment they observed it.

## Prediction

Before running anything, predict:

1. Under Repeatable Read, if Alice's transaction and Bob's transaction both
   take their snapshot before either commits, does either transaction's
   `SELECT` ever return incorrect data? Does Postgres raise any error?
2. Under Serializable, the identical interleaving is run. Does Postgres
   allow both commits, reject both, or reject exactly one? What SQLSTATE is
   raised, and on which statement?
3. After a bounded retry loop resolves both requests, is the final state
   always "one succeeds, one is rejected"? Could it instead be "both
   succeed" or "both are rejected"? Why?
4. With 5 staff all racing to go off call at once under Serializable, will
   the total number of attempts across all 5 workers equal exactly 5, or
   more? Under Repeatable Read with no retry logic, will it ever be more
   than 5?

## Exercise

1. Run the setup commands above.
2. Run `pnpm scenario:write-skew` - watch Alice's and Bob's reads and writes
   interleave, and confirm the final on-call count.
3. Run `pnpm scenario:serializable-conflict` - the exact same interleaving,
   now under Serializable. Watch one commit succeed and the other fail with
   a real SQLSTATE `40001`.
4. Run `pnpm scenario:serializable-retry` - real concurrency this time
   (`Promise.all`, not a scripted interleaving), wrapped in a bounded retry
   loop. Watch whichever request loses the race retry, re-read fresh state,
   and correctly refuse.
5. Run `pnpm scenario:contention` - a 5-person version of the same race,
   comparing total attempts/conflicts under Serializable+retry against the
   same workload under Repeatable Read with no retry at all.
6. Run `pnpm test` and read the assertions - they check final on-call counts
   and outcome types, never timing or which specific staff member "won".

## Observe

- **PGweb** (http://localhost:8409): browse `on_call_staff` after each
  scenario and watch `is_on_call` settle into its post-scenario state.
- **`docker compose logs postgres`**: with `log_statement=all`, see the exact
  `BEGIN`, `SET TRANSACTION ISOLATION LEVEL ...`, `SELECT`, `UPDATE`, and
  `COMMIT`/`ROLLBACK` statements each scenario sent.
- **Structured logs**: every scenario logs through `@labs/logging` (Pino),
  including `staffId`, `attempt`, `sqlstate`, `backoffMs`, and a final
  boolean verdict field (`invariantHeld`, `exactlyOneSucceeded`).
- **`playground/notes.md`**: manual `psql` steps to watch `pg_locks` for
  `SIReadLock` rows (the predicate locks SSI uses to detect the conflict)
  while a Serializable transaction is open.

## Break it

Run `pnpm scenario:write-skew` and look at a real captured run:

```json
{"aliceId":"13","bobId":"14","actualIsolationLevel":"repeatable read"}
{"othersOnCallSeenByAlice":1}
{"othersOnCallSeenByBob":1}
{"aliceDecision":"go-off-call"}
{"bobDecision":"go-off-call"}
{"onCallCountAfter":0,"invariantHeld":false}
```

Both Alice's and Bob's transactions took a REPEATABLE READ snapshot before
either committed. Each one's `SELECT` legitimately saw the other doctor still
on call - that was true when the snapshot was taken. Each independently
decided it was safe to go off call. Both `UPDATE`s targeted different rows,
so Postgres's same-row conflict detection never triggers, and both `COMMIT`s
succeed. Final state: zero doctors on call. No error was ever raised. This is
not a bug - it is Repeatable Read's documented contract (snapshot isolation
prevents same-row write conflicts, not read/write dependencies across rows).

## Fix it

Run `pnpm scenario:serializable-conflict` - identical setup, identical
interleaving, only `SERIALIZABLE` instead of `REPEATABLE READ`:

```json
{"aliceId":"13","bobId":"14","actualIsolationLevel":"serializable"}
{"othersOnCallSeenByAlice":1}
{"othersOnCallSeenByBob":1}
"transaction A: Alice commits 'go off call' - succeeds, no conflict yet"
{"sqlstate":"40001","message":"could not serialize access due to read/write dependencies among transactions"}
{"onCallCountAfter":1,"invariantHeld":true}
```

Alice's commit succeeds (nothing has gone wrong yet from Postgres's point of
view). Bob's commit is REJECTED with SQLSTATE `40001` - a real, documented
Postgres error, not a timeout or a lock wait. The invariant now holds: one
doctor remains on call.

But rejecting Bob's transaction is only half a fix - Bob's clock-out request
has simply vanished. `pnpm scenario:serializable-retry` completes the fix
with a bounded retry loop (`src/scenarios/serializable-with-retry.ts`):

```json
{"staffName":"Dr. Bob Nkemelu","attempt":1,"sqlstate":"40001","backoffMs":46}
{"staffName":"Dr. Alice Chen","attempt":1,"outcome":"committed","othersOnCall":1}
{"staffName":"Dr. Bob Nkemelu","attempt":2,"outcome":"rejected","othersOnCall":0}
{"onCallCountAfter":1,"invariantHeld":true,"exactlyOneSucceeded":true}
```

Bob's transaction hits `40001` on attempt 1, waits a randomized backoff, and
retries with a **brand-new transaction that re-reads current state** -
not a replay of the original "go off call" decision. On the re-read, Bob's
transaction sees `othersOnCall: 0` (Alice already committed her clock-out)
and correctly, permanently refuses: going off call is now genuinely unsafe.
This is the critical detail a naive retry loop gets wrong - retrying must
re-derive the decision from fresh data, not blindly re-run the same write.

## Why the fix works

Postgres's Serializable isolation is implemented as **Serializable Snapshot
Isolation (SSI)**: on top of the same snapshot machinery Repeatable Read
uses, Postgres additionally tracks predicate locks (`SIReadLock`) recording
what each transaction's queries logically depended on, and watches for
**rw-antidependencies** - cases where transaction T1 read a value that
transaction T2 later overwrote. A single rw-antidependency is harmless. A
**cycle** of two rw-antidependencies between the same two concurrent
transactions is the "dangerous structure" write skew always produces:

- Alice's transaction read Bob's row (via the "anyone else on call?" query)
  while it was still `true`; Bob's transaction later wrote that row to
  `false` -> edge Alice -> Bob.
- Bob's transaction read Alice's row while it was still `true`; Alice's
  transaction later wrote that row to `false` -> edge Bob -> Alice.

Two edges in opposite directions between the same pair of transactions form
exactly the cycle SSI is built to catch. Since Alice's transaction already
committed by the time Bob's tries to commit, Postgres cannot retroactively
undo Alice - so it aborts Bob instead, with SQLSTATE `40001`, guaranteeing
that no execution history equivalent to running Alice's and Bob's
transactions one-at-a-time (in either order) could have produced two
`false`s. That "as if serial" guarantee is precisely what "Serializable"
means, and it is why a bounded retry loop that re-reads fresh state on every
attempt is sufficient to reach a correct final state: every surviving
committed transaction is consistent with *some* serial ordering of all
transactions that ever ran.

## Tradeoffs

- **Repeatable Read vs Serializable**: Repeatable Read never aborts a
  transaction for this anomaly and is cheaper (fewer predicate locks to
  track), but it can silently produce a state that violates a cross-row
  invariant. Serializable detects it, but the detection mechanism is a hard
  abort - your application must be able to retry, and the abort itself costs
  a full extra round trip (or more) per conflict.
- **Predicate lock (`SIReadLock`) memory**: SSI needs to track what every
  Serializable transaction's queries logically read, not just what rows they
  locked. This has a real memory cost (`max_pred_locks_per_transaction` and
  friends) and does not scale to unlimited transaction complexity or an
  unlimited number of concurrently open Serializable transactions.
- **Retry loop simplicity vs correctness**: reusing one connection across
  retry attempts and just re-issuing the same `UPDATE` would be wrong -
  after a `40001`, the transaction is dead and the connection must
  `ROLLBACK` before it can do anything else; more importantly, a correct
  retry must re-derive its decision from a fresh read, or it just repeats
  the original mistake. This lab's `attemptGoOffCall` deliberately opens a
  fresh transaction (simulating a fresh pool checkout) on every attempt.
- **Bounded vs unbounded retries**: an unbounded retry loop under sustained
  contention can spin forever and starve a request; this lab bounds attempts
  (`maxAttempts`) and throws loudly if the bound is exhausted, rather than
  silently giving up or looping forever.

## Production notes

1. **What guarantee does this mechanism give?** Serializable guarantees the
   combined effect of all committed Serializable transactions is equivalent
   to running them one at a time in *some* order - no execution can produce
   a result impossible under any serial ordering. This is strictly stronger
   than "each row's writes don't conflict" (Repeatable Read's guarantee).
2. **What does it not guarantee?** It does not guarantee your transaction
   commits on the first try, does not guarantee which of two conflicting
   transactions is the one aborted, and does not guarantee low latency under
   contention - see the measured numbers below.
3. **What breaks under process crash?** No new risk versus any other
   isolation level: an aborted-by-Postgres transaction (`40001`) is
   indistinguishable, from the data's perspective, from a transaction that
   never ran. The risk is entirely in the application: if a caller does not
   retry (or does not know it must), the "go off call" request is silently
   lost, not silently wrong - which is still a real availability bug.
4. **What breaks under network partition?** Not applicable here - single
   Postgres node, no replicas (see the replication labs, 24+).
5. **What changes at high contention?** The measured comparison below:
   5 workers racing to go off call needed **11 total attempts and 6
   real `40001` conflicts** to reach the correct 4-committed/1-rejected
   split under Serializable+retry, versus exactly **5 attempts and 0
   conflicts** under Repeatable Read with no retry - but the Repeatable Read
   run left **zero** staff on call (invariant violated). Abort rate under
   Serializable grows with the degree of overlapping writes to the same
   logical predicate, not just row count - a hot, frequently-contended
   invariant will see a much higher abort rate than this lab's 5-way race.
6. **What changes with multiple regions?** Not applicable yet - Serializable
   correctness reasoning assumes a single serialization point (one primary);
   see the replication labs for what changes once reads can go to a replica.
7. **What metrics would you monitor?** Serialization failure rate
   (`pg_stat_database.conflicts` is for replicas; application-side, track
   the count and rate of caught `40001`s per endpoint), retry attempts per
   logical request (a rising average signals rising contention), and
   `pg_locks` rows with `mode = 'SIReadLock'` as a leading indicator of
   predicate-lock pressure.
8. **What simpler alternative could be used?** If the invariant can be
   pinned to a single row (e.g., a `remaining_on_call_count` counter with a
   `CHECK (remaining_on_call_count >= 1)` and an atomic decrement), a normal
   `UPDATE ... WHERE remaining_on_call_count > 1` conditional write under
   Read Committed enforces the same invariant without ever needing
   Serializable - datastore-native guarantees (Lab 11's optimistic
   concurrency) beat Serializable whenever the invariant can be reshaped to
   fit in one row.
9. **When should you avoid this technique?** Avoid Serializable for
   high-throughput, high-contention write paths where the invariant *can*
   be expressed as a single-row constraint or conditional write instead -
   the abort-and-retry cost is real and grows with contention, as measured
   above. Reach for Serializable when the invariant genuinely spans multiple
   rows/tables and cannot be reshaped, and when the workload's contention
   level is low enough that the retry cost is acceptable.

## Interview questions

1. Why does Repeatable Read (Postgres's snapshot isolation) fail to prevent
   write skew, when it does prevent two transactions from both updating the
   same row based on stale data?
2. What exactly is a "dangerous structure" in Serializable Snapshot
   Isolation, and why does it require a *cycle* of rw-antidependencies, not
   just one?
3. If a Serializable transaction retries after a `40001` and reuses the
   values it read on its first (failed) attempt instead of re-reading, what
   specifically goes wrong?
4. Why can Postgres only ever abort ONE side of a two-transaction write-skew
   conflict once one side has already committed?
5. Give a concrete invariant that genuinely cannot be reshaped into a
   single-row `CHECK` or counter, and explain why Serializable (rather than
   an advisory lock) is the right tool for it.
6. Why might Serializable reduce throughput even when no transaction is
   actually aborted?
7. What would you monitor in production to know whether your Serializable
   retry loop's `maxAttempts` bound is too low?

## Further experiments

- In `src/seed/scenario-staff.ts`, grow `CONTENTION_STAFF` from 5 to 10 or 20
  members and rerun `pnpm scenario:contention` - predict, then confirm,
  whether `totalConflicts` grows linearly or faster than staff count.
- In `contention-and-throughput.ts`, set `FIRST_ATTEMPT_DELAY_MS` to `0` and
  rerun the Serializable scenario several times - with no forced overlap,
  some runs may resolve with zero conflicts purely because the workers
  happened not to race, which is exactly why the delay exists (see
  `playground/notes.md`).
- In `serializable-with-retry.ts`, set `maxAttempts` to `1` and rerun under
  the concurrent demo - watch the retry loop legitimately throw "exhausted 1
  attempts" instead of silently accepting whatever the first attempt
  produced.
- Add a third, concurrent staff member to the write-skew team and predict
  whether Serializable can still guarantee "exactly one stays on call", or
  whether multiple valid outcomes now exist.
- Open two `psql` sessions and reproduce `serializable-detects-conflict.ts`
  by hand (see `playground/notes.md`), then query
  `SELECT * FROM pg_locks WHERE mode = 'SIReadLock';` from a third session
  while both transactions are open, to see the predicate locks SSI is
  tracking before either commits.

## Real validation run (captured output)

The following are actual values captured from a real run against this lab's
Docker Compose stack (not hypothetical/aspirational output).

**`pnpm scenario:write-skew`:**

```json
{"aliceId":"13","bobId":"14","actualIsolationLevel":"repeatable read"}
{"othersOnCallSeenByAlice":1}
{"othersOnCallSeenByBob":1}
{"aliceDecision":"go-off-call"}
{"bobDecision":"go-off-call"}
{"onCallCountAfter":0,"invariantHeld":false}
```

**`pnpm scenario:serializable-conflict`:**

```json
{"aliceId":"13","bobId":"14","actualIsolationLevel":"serializable"}
{"othersOnCallSeenByAlice":1}
{"othersOnCallSeenByBob":1}
{"aliceCommitted":true}
{"bobCommitted":false,"bobFailure":{"sqlstate":"40001","message":"could not serialize access due to read/write dependencies among transactions"}}
{"onCallCountAfter":1,"invariantHeld":true}
```

**`pnpm scenario:serializable-retry`:**

```json
{"staffName":"Dr. Bob Nkemelu","attempt":1,"outcome":"conflict","sqlstate":"40001","backoffMs":46}
{"staffName":"Dr. Alice Chen","attempt":1,"outcome":"committed","othersOnCall":1}
{"staffName":"Dr. Bob Nkemelu","attempt":2,"outcome":"rejected","othersOnCall":0}
{"onCallCountAfter":1,"invariantHeld":true,"exactlyOneSucceeded":true}
```

**`pnpm scenario:contention`** (5 staff, all initially on call):

```json
{"team":"Serializable+retry","staffCount":5,"totalAttempts":11,"totalConflicts":6,"committedCount":4,"rejectedCount":1,"onCallCountAfter":1,"invariantHeld":true,"wallClockMs":331}
{"team":"Repeatable Read, no retry","staffCount":5,"totalAttempts":5,"totalConflicts":0,"wentOffCallCount":5,"onCallCountAfter":0,"invariantHeld":false,"wallClockMs":186}
```

Serializable+retry needed **more than double the attempts** (11 vs. 5) and
**6 real serialization aborts** to reach the correct answer; Repeatable Read
needed no retries at all and reached the wrong one (0 staff left on call
instead of the required 1).

`pnpm test` (7 tests across 4 files) and `pnpm typecheck` both pass cleanly
against this output. The full reset flow
(`docker compose down -v && docker compose up -d`, then
`db:migrate` → `seed` → `test`) was also verified from a clean slate.
