# Lab 13 - PostgreSQL Advisory Locks

## Why this exists

Every payroll company must have its payroll processed by exactly one worker
at a time - two workers racing to compute company 5's payroll run
simultaneously is a correctness hazard even if no single row-level
constraint is being violated. Row locks (Lab 10) and conditional writes
(Lab 11) protect a specific row. Advisory locks protect neither a row nor a
table - they let independent processes agree, by convention, "I am the one
allowed to do this piece of work right now," using PostgreSQL itself as the
coordination point instead of standing up Redis or Zookeeper for it.

The uncomfortable half of this lesson is the one CLAUDE.md insists on: an
advisory lock is a promise made only to callers who choose to check it. It
does not sit on a row the way a row lock does. A second connection - a
buggy code path, a forgotten cooperating check, a `psql` session someone
opened by hand - can update the exact row the lock was meant to protect,
instantly, without ever knowing the lock exists. This lab makes both halves
happen against a real, running Postgres instance: the coordination working
correctly, and the coordination providing zero protection to a caller that
doesn't participate in it.

## Learning objectives

After this lab you should be able to:

- explain the difference between a session-level advisory lock
  (`pg_advisory_lock`/`pg_advisory_unlock`, released explicitly or on
  disconnect) and a transaction-level advisory lock
  (`pg_advisory_xact_lock`, released automatically at `COMMIT` or
  `ROLLBACK`, with no unlock function);
- use the blocking (`pg_advisory_lock`) and non-blocking
  (`pg_try_advisory_lock`) variants correctly, and know which one a
  "claim this piece of work or move on" worker needs;
- state, and prove against a running Postgres instance, that a session-level
  advisory lock is released automatically if its holding connection
  disconnects - even without an explicit unlock call;
- state, and prove, that an advisory lock provides **zero** protection
  against a caller that never checks it - it coordinates cooperating
  actors, it does not lock a row;
- choose a lock-key strategy (a stable internal numeric id vs. a hashed
  public UUID) and explain the collision tradeoff of hashing a 128-bit UUID
  down to a 32-bit or 64-bit key space.

## Architecture

```text
┌──────────────────────────┐        ┌───────────────────────────┐
│ src/scenarios/            │        │                           │
│ session-lock-blocking      │──────▶│                           │
│ (3 pg.Client "workers":    │        │       PostgreSQL          │
│  A blocking-locks, B/C try)│──────▶│  companies / employees /   │◀── pgweb
├───────────────────────────┤        │      payroll_runs         │    (browser UI)
│ xact-lock-auto-release      │──────▶│                           │
│ connection-loss-releases-   │──────▶│                           │
│  lock                       │        │                           │
│ advisory-lock-does-not-      │──────▶│                           │
│  protect-rows (the "buggy   │        │                           │
│  connection" bypasses the   │        └───────────────────────────┘
│  lock entirely)             │                     ▲
│ uuid-vs-numeric-lock-key     │              seed.ts / migrate.ts
└───────────────────────────┘
```

Domain: a minimal slice of **payroll** (SPEC.md ยง8.2) - `companies`,
`employees`, and `payroll_runs`. This is this lab's own independent copy of
the companies/employees shape Lab 01 also uses, per the independent-labs
principle (no import from Lab 01/02). `payroll_runs` is new here: one row
per company representing its current payroll run (`status`, `total_cents`,
`processed_by_worker`), deliberately modeled as "one current run" rather
than a full payroll-period history table, since the point of this lab is
the locking mechanism, not a rich payroll domain - it exists specifically to
give `advisory-lock-does-not-protect-rows.ts` a real row to update.

Every scenario uses two or three independent `pg.Client` connections driven
with raw SQL, never Drizzle's query builder - the same pattern Lab 07
established for isolation-level experiments (`src/scenarios/support.ts`),
extended here to three simulated workers where the scenario calls for it
(`session-lock-blocking.ts`). Per CLAUDE.md's "Advisory Locks" section, the
lock calls themselves (`pg_advisory_lock`, `pg_try_advisory_lock`,
`pg_advisory_unlock`, `pg_advisory_xact_lock`, `pg_try_advisory_xact_lock`)
are never wrapped behind an ORM-level abstraction that would hide which
function is actually being called.

**Deviation from SPEC.md's literal "company 5"/"company 6" framing:**
SPEC.md's Lab 13 section illustrates the lock-granularity demonstration as
"worker A processes company 5; worker B cannot process company 5; worker C
can process company 6." Those numbers are illustrative identifiers, not a
literal requirement that the seeded row's numeric id be `5`. Companies here
have a `GENERATED ALWAYS AS IDENTITY` id (same as Lab 01/07) and this lab's
seed deletes-then-reinserts rather than `TRUNCATE ... RESTART IDENTITY`
(consistent with Lab 01 and Lab 07's seeds), so the identity sequence keeps
advancing across repeated `pnpm seed` runs and a fixed numeric id like `5`
would not reliably exist after a reseed. Instead, following the exact
pattern Lab 07 established with its named `SCENARIO_ACCOUNTS`, this lab
seeds two fixed, named companies - **"Scenario Company - Alpha (locked by
Worker A)"** (plays the role of SPEC's "company 5") and **"Scenario Company
- Beta (different lock key)"** (plays the role of SPEC's "company 6") -
looked up by name at runtime by every scenario and test
(`src/seed/scenario-companies.ts`). See "Real validation run" below for the
actual numeric ids captured from a real seed.

## Setup

```bash
pnpm install
cp labs/13-advisory-locks/.env.example labs/13-advisory-locks/.env
cd labs/13-advisory-locks
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate
pnpm seed
```

Open PGweb at http://localhost:8413 (it auto-connects via
`PGWEB_DATABASE_URL`). You should see `companies` (2 fixed "Scenario Company
- ..." rows plus a handful of faker-generated payroll companies),
`employees`, and `payroll_runs` (one row per company).

## Scenario

A payroll company's payroll run must be processed by exactly one worker at a
time. Multiple worker processes (or multiple instances of the same service)
poll for companies whose payroll is due and each tries to "claim" a company
before processing it. PostgreSQL's advisory locks are a `bigint`- (or two
`int`-) keyed lock namespace, entirely separate from row/table locks,
designed exactly for this: cheap, session- or transaction-scoped
coordination keyed by an application-chosen number, with no schema of its
own.

## Prediction

Before running anything, predict:

1. Worker A takes a blocking `pg_advisory_lock` on company Alpha's numeric
   id and does not release it yet. Worker B calls `pg_try_advisory_lock` on
   the SAME key. Does B block, or does it return immediately with `false`?
2. At the same moment, Worker C calls `pg_try_advisory_lock` on company
   Beta's (a *different* company's) numeric id. Does C also get `false`
   (implying one global lock), or `true` (implying per-key granularity)?
3. Worker A opens a transaction and calls `pg_advisory_xact_lock`, then
   never calls any unlock function at all, and simply commits. Is the lock
   still held after `COMMIT`?
4. Worker A takes a session-level `pg_advisory_lock` and its process then
   crashes (its TCP connection to Postgres is severed) without calling
   `pg_advisory_unlock`. Does the lock stay held forever, or does Postgres
   release it?
5. Worker A holds an advisory lock on company Alpha's key. A second,
   completely separate connection that never calls any `pg_advisory_*`
   function issues `UPDATE payroll_runs SET ... WHERE company_id = <Alpha>`.
   Does that `UPDATE` block, get rejected, or succeed immediately?

## Exercise

1. Run the setup commands above.
2. Run `pnpm scenario:session-lock-blocking` and read the log output - worker
   A holds a blocking lock, worker B's try-lock on the same key fails, worker
   C's try-lock on a different key succeeds immediately, and worker B
   succeeds once A releases.
3. Run `pnpm scenario:xact-lock-auto-release` and read the log output - a
   transaction-level lock blocks a concurrent try-lock while open, and frees
   itself the instant the holder's transaction ends, whether by `COMMIT` or
   `ROLLBACK`, with no unlock call ever made.
4. Run `pnpm scenario:connection-loss` and read the log output - a
   session-level lock held by a connection that is then closed (simulating a
   crash) becomes available to a new session, again with no unlock call.
5. Run `pnpm scenario:row-protection` and read the log output carefully -
   this is the lab's central lesson. A connection that never touches any
   advisory-lock function updates the exact row a lock is supposedly
   protecting, instantly.
6. Run `pnpm scenario:lock-key-strategies` and compare a lock key derived
   directly from a company's internal numeric id against two ways of
   deriving a key from its public UUID.
7. Run `pnpm test` and read the assertions - they check the actual boolean
   results Postgres returned, not timing or log output.

## Observe

- **PGweb** (http://localhost:8413): browse `payroll_runs` after running
  `pnpm scenario:row-protection` and see `status = 'corrupted-by-bypass'` -
  written by a connection that never touched an advisory lock, while a
  different connection believed it held exclusive access.
- **`docker compose logs postgres`**: with `log_statement=all`, see the
  exact `SELECT pg_advisory_lock(...)`, `SELECT pg_try_advisory_lock(...)`,
  `SELECT pg_advisory_unlock(...)`, `SELECT pg_advisory_xact_lock(...)`, and
  `SELECT pg_try_advisory_xact_lock(...)` calls each scenario sent.
- **`pg_locks`**: while a scenario script is paused (e.g. add a longer sleep
  in `session-lock-blocking.ts` and run it), connect with `psql` and run
  `SELECT locktype, mode, granted, pid FROM pg_locks WHERE locktype =
  'advisory';` - advisory locks are real rows in the same lock table row
  locks use, distinguished by `locktype = 'advisory'`.
- **Structured logs**: every scenario logs through `@labs/logging` (Pino),
  including the exact `companyId`, the boolean result of every lock call,
  and timing (`tookMs`, `directUpdateDurationMs`).

## Break it

The "break" here is the naive assumption CLAUDE.md explicitly warns against:
that taking an advisory lock is equivalent to locking the row(s) it's meant
to protect. Run `pnpm scenario:row-protection` and look at a real captured
run:

```json
{"companyId":7,"msg":"worker A holds pg_advisory_lock for this company - believes it is the only writer 'processing payroll'"}
{"companyId":7,"rowCount":1,"directUpdateDurationMs":1,"msg":"a connection that NEVER called pg_advisory_lock updated the SAME row anyway, instantly, while the lock was held"}
{"companyId":7,"lockHeldByWorkerA":true,"directUpdateRowCount":1,"directUpdateSucceededWhileLockHeld":true,"directUpdateDurationMs":1,"finalStatus":"corrupted-by-bypass"}
```

Worker A never released its lock before the second connection's `UPDATE`
ran. That `UPDATE` was not queued, not blocked, not rejected - it committed
in 1ms, exactly as fast as it would have with no lock held anywhere. If your
mental model was "the lock protects the row," this is the proof that it does
not: Postgres's advisory-lock functions have no relationship whatsoever to
the MVCC/row-lock machinery that governs actual row access. They are a
completely separate, application-opt-in namespace.

## Fix it

There is no code fix for "a caller that doesn't check the lock can still
write the row" - that is not a bug, it's what an advisory lock is. The fix
is entirely in where you place the guarantee:

- **If every writer is your own code and you control every code path**: the
  fix is discipline - every code path that touches a company's payroll data
  must call the same lock function with the same key before writing,
  including one-off scripts and admin tools. This lab's
  `session-lock-blocking.ts` and `xact-lock-auto-release.ts` scenarios show
  that *when every caller cooperates*, the coordination works correctly and
  reliably.
- **If you cannot guarantee every writer cooperates** (a `psql` session run
  by hand, a second application, a bug that skips the lock call): the
  invariant does not belong in an advisory lock at all. Put it where
  PostgreSQL enforces it unconditionally - a `SELECT ... FOR UPDATE` row
  lock (Lab 10), a conditional write / optimistic-concurrency version column
  (Lab 11), or a `CHECK`/unique constraint if the invariant can be expressed
  that way. Those apply to every writer automatically, cooperating or not.
- **Choosing session vs. transaction-level locks**: use
  `pg_advisory_xact_lock` whenever the unit of work you're protecting is a
  single database transaction - it is impossible to forget to release it,
  because Postgres releases it for you at `COMMIT`/`ROLLBACK` (see
  `xact-lock-auto-release.ts`). Reach for the session-level
  `pg_advisory_lock`/`pg_advisory_unlock` pair only when the critical
  section must span multiple transactions or isn't transactional at all -
  and even then, `connection-loss-releases-lock.ts` shows Postgres still has
  your back if the holding process crashes: the lock is tied to the backend
  connection's lifetime, not to an explicit unlock call.

## Why the fix works

Advisory locks are implemented as an in-memory, per-backend lock table keyed
by an application-chosen number (or number pair), entirely independent of
any table, row, or MVCC visibility rule. `pg_advisory_lock` and
`pg_try_advisory_lock` register the calling backend as holding a given key;
`pg_advisory_unlock` removes that registration; a backend disconnecting
(voluntarily or via crash) causes Postgres to remove every advisory-lock
registration for that backend as part of normal session cleanup - the same
cleanup that also rolls back any open transaction, which is exactly what
`connection-loss-releases-lock.ts` demonstrates. `pg_advisory_xact_lock`
additionally ties the registration's lifetime to the current transaction, so
it disappears at `COMMIT` or `ROLLBACK` without needing its own cleanup
hook - there is deliberately no `pg_advisory_xact_unlock` function, because
the transaction boundary already is the release point.

None of that machinery has any awareness of `payroll_runs`, `UPDATE`
statements, or row versions - which is exactly why a connection that never
calls any `pg_advisory_*` function is completely unaffected by one being
held. Only mechanisms that are wired into Postgres's actual row-visibility
and locking engine (row locks, `UPDATE`'s implicit lock, unique constraints,
`CHECK` constraints) apply to every writer unconditionally.

## Tradeoffs

- **Advisory locks vs. row locks for "one worker per company"**: an advisory
  lock lets you coordinate on a key that doesn't have to correspond to a
  single row (or any row at all) and lets you take/release it outside a
  transaction if needed. The cost is exactly what this lab demonstrates: it
  provides zero protection against a non-cooperating caller, unlike a row
  lock that Postgres enforces on every `UPDATE`/`SELECT ... FOR UPDATE`
  regardless of who issues it.
- **Session-level vs. transaction-level locks**: transaction-level
  (`pg_advisory_xact_lock`) is harder to leak (no unlock call to forget) but
  ties the lock's lifetime to a single transaction, which is awkward if the
  critical section spans multiple statements/transactions or involves
  waiting on an external system. Session-level (`pg_advisory_lock`) is more
  flexible but requires the caller to reliably call
  `pg_advisory_unlock` (or hold a connection whose lifetime you control) -
  `connection-loss-releases-lock.ts` shows the worst case (a crash) is still
  safe, but a *long-lived, still-connected* process that simply forgets to
  unlock will hold the key indefinitely.
- **Blocking (`pg_advisory_lock`) vs. non-blocking
  (`pg_try_advisory_lock`)**: blocking is simpler to reason about for a
  worker that must eventually process a specific company, but ties up a
  connection while waiting. Non-blocking is the right shape for a
  work-queue-style worker that should skip contended work and move on to
  the next item (compare with `SELECT ... FOR UPDATE SKIP LOCKED`, Lab 14,
  which achieves a similar "don't wait, try something else" goal for row
  locks instead of advisory locks).
- **Numeric internal id vs. hashed public UUID as the lock key**: a numeric
  id has zero collision risk within its own table and is the simplest
  option whenever the lock's caller already has that id. A hashed UUID is
  necessary when the lock key must be namespaced across multiple entity
  types or derived from an externally-facing identifier, but it trades a
  128-bit key space down to 32 or 64 bits, which introduces a real (if
  usually small) collision probability - see the Exercise output below.

## Production notes

1. **What guarantee does this mechanism give?** That, among callers who all
   correctly call the same advisory-lock function with the same key, at
   most one of them holds that key at a time (session- or
   transaction-scoped). Nothing more.
2. **What does it not guarantee?** It does not lock, protect, or even know
   about any row, table, or column. A caller that skips the lock call is
   completely unaffected by another caller holding it - proven directly by
   `advisory-lock-does-not-protect-rows.ts`.
3. **What breaks under process crash?** Session-level locks are released
   automatically when the holding backend's connection terminates
   (`connection-loss-releases-lock.ts`); transaction-level locks are
   released automatically at the end of the transaction regardless of how
   it ends. Neither can "leak" past process death the way, say, a
   forgotten-to-release external lease could - but a long-lived process that
   simply never calls unlock, while still connected, does leak the lock for
   as long as that connection stays open.
4. **What breaks under network partition?** Not directly applicable at this
   lab's scale (single Postgres node, single process per "worker") - but
   note that from Postgres's point of view, a network partition between an
   application and the database looks identical to a crash: the backend
   connection eventually terminates and the session-level lock is released,
   even if the application process is still alive and believes it holds the
   lock. A partitioned-but-alive worker can therefore lose its lock without
   knowing it - a real risk this lab does not model further (see Lab 22's
   fencing-token discussion for how leases address the analogous problem).
5. **What changes at high contention?** Blocking locks (`pg_advisory_lock`)
   queue waiters FIFO the same way row locks do, so throughput degrades
   gracefully but latency grows with the queue. Non-blocking locks
   (`pg_try_advisory_lock`) never queue - callers must have a policy for
   "what to do when the key is taken" (retry later, skip, requeue).
6. **What changes with multiple regions?** Advisory locks are local to one
   Postgres instance; they provide no coordination across a
   primary/replica topology or between regions each running their own
   database. A single-writer-primary architecture (this repository's
   default) keeps this simple; a multi-primary or multi-region write
   topology would need a different coordination mechanism entirely.
7. **What metrics would you monitor?** Advisory-lock wait time (for
   blocking callers), try-lock failure rate (for non-blocking callers, as a
   proxy for contention), count of held-but-long-lived advisory locks
   (`pg_locks WHERE locktype = 'advisory'` joined to `pg_stat_activity` for
   how long that backend has been connected), and - most importantly for
   the lesson of this lab - an application-level audit of which code paths
   actually call the lock function, since Postgres cannot report "a caller
   skipped this."
8. **What simpler alternative could be used?** If the invariant can be
   expressed as "at most one row may exist/be in this state," a unique
   constraint or a conditional write (Lab 11) is simpler and applies to
   every writer unconditionally - prefer it whenever possible, per
   `docs/architecture-principles.md` ยง1 "Keep guarantees close to the
   data."
9. **When should you avoid this technique?** Avoid advisory locks whenever
   you cannot guarantee every writer of the protected data cooperates with
   the same lock key and function - at that point you need a real
   constraint or row lock instead. Also avoid session-level locks held
   across a long-lived connection pool member without careful lifecycle
   management - a forgotten unlock on a pooled connection can block every
   future borrower of that key indefinitely.

## Interview questions

1. What, precisely, does `pg_advisory_lock(42)` succeeding tell you about
   the state of any table in the database?
2. Why does `pg_advisory_xact_lock` have no corresponding unlock function,
   while `pg_advisory_lock` does?
3. A worker holds a session-level advisory lock and then its process
   crashes. Does the lock stay held? Why or why not, and what Postgres
   mechanism is responsible?
4. Give a concrete scenario where an advisory lock is the right tool, and
   one where the same problem should instead be solved with `SELECT ... FOR
   UPDATE` or a unique constraint.
5. Why would `SKIP LOCKED` (Lab 14) be a better fit than an advisory lock
   for a job-queue worker that should move on to other work when the next
   item is contended?
6. You need a lock key derived from a UUID instead of an internal numeric
   id. What's the practical difference between hashing it into one bigint
   key vs. splitting it into two int32 keys?
7. Why does hashing a UUID into a 32-bit key space carry meaningfully more
   collision risk than hashing it into a 64-bit space, even though both
   feel "big enough" intuitively?

## Further experiments

- In `src/scenarios/session-lock-blocking.ts`, increase `HOLD_MS` and, while
  it's running, open a `psql` session and run `SELECT pid, mode, granted
  FROM pg_locks WHERE locktype = 'advisory';` - identify which `pid`
  corresponds to which simulated worker via `pg_stat_activity`.
- Modify `connection-loss-releases-lock.ts` to send `SIGKILL` to a spawned
  child Node process holding the lock (instead of just calling `client.end()`
  in the same process) and confirm the release behavior is identical - a
  session-level advisory lock's lifetime is tied to the Postgres backend
  process noticing the TCP connection is gone, not to how gracefully the
  client-side code shut down.
- Extend `uuid-vs-numeric-lock-key.ts` to seed 100,000 companies and
  actually count real `hashtext()` collisions among their public UUIDs
  (`SELECT hashtext(public_id::text), count(*) FROM companies GROUP BY 1
  HAVING count(*) > 1`) and compare the observed count to
  `approxCollisionProbability`'s prediction.
- Add a fourth worker to `session-lock-blocking.ts` that also tries company
  Alpha's key with `pg_advisory_lock` (blocking, not try) while A holds it,
  and confirm it queues rather than erroring - then have A release and
  confirm exactly one of the waiting blocking callers wins.

## Real validation run (captured output)

The following are actual values captured from a real run against this lab's
Docker Compose stack (not hypothetical/aspirational output). Company ids
shown are from the specific seed run that produced them - see the
"Deviation" note in Architecture for why these are looked up by name, not
assumed to be `5`/`6`.

**`pnpm seed` (fresh volume):**

```json
{"scenarioCompanies":[{"id":1,"name":"Scenario Company - Alpha (locked by Worker A)"},{"id":2,"name":"Scenario Company - Beta (different lock key)"}]}
{"scenarioCompanies":2,"browsingCompanies":4,"employees":24}
```

**`pnpm scenario:session-lock-blocking`:**

```json
{"worker":"A","companyId":7,"msg":"worker A: pg_advisory_lock (blocking) - acquiring"}
{"worker":"A","companyId":7,"tookMs":1,"msg":"worker A: lock acquired, holding while 'processing'"}
{"worker":"B","companyId":7,"acquired":false,"msg":"worker B: pg_try_advisory_lock on the SAME key while A still holds it"}
{"worker":"C","companyId":8,"acquired":true,"msg":"worker C: pg_try_advisory_lock on a DIFFERENT key, at the same moment A still holds company A's key"}
{"worker":"A","companyId":7,"released":true,"msg":"worker A: pg_advisory_unlock"}
{"worker":"B","companyId":7,"acquired":true,"msg":"worker B: retried pg_try_advisory_lock after A released - the key is free again"}
{"companyAId":7,"companyBId":8,"workerBAcquiredWhileALocked":false,"workerCAcquiredDifferentKeyImmediately":true,"workerBRetryAfterReleaseAcquired":true,"holdDurationMs":800}
```

**`pnpm scenario:xact-lock-auto-release`:**

```json
{"companyId":7,"msg":"holder (COMMIT case): BEGIN + pg_advisory_xact_lock acquired"}
{"companyId":7,"acquired":false,"msg":"checker: pg_try_advisory_xact_lock while holder's transaction is still open"}
{"companyId":7,"msg":"holder (COMMIT case): COMMIT - no explicit unlock call was ever made"}
{"companyId":7,"acquired":true,"msg":"checker: pg_try_advisory_xact_lock immediately after holder's COMMIT"}
{"companyId":7,"msg":"holder (ROLLBACK case): BEGIN + pg_advisory_xact_lock acquired"}
{"companyId":7,"acquired":false,"msg":"checker: pg_try_advisory_xact_lock while holder's transaction is still open"}
{"companyId":7,"msg":"holder (ROLLBACK case): ROLLBACK - no explicit unlock call was ever made"}
{"companyId":7,"acquired":true,"msg":"checker: pg_try_advisory_xact_lock immediately after holder's ROLLBACK"}
```

**`pnpm scenario:connection-loss`:**

```json
{"companyId":7,"msg":"worker A: pg_advisory_lock acquired - will 'crash' without unlocking"}
{"companyId":7,"acquired":false,"msg":"worker B: pg_try_advisory_lock while A's connection is still open"}
{"companyId":7,"msg":"worker A: connection closed via client.end() - pg_advisory_unlock was NEVER called"}
{"companyId":7,"acquired":true,"msg":"worker B: pg_try_advisory_lock again, after A's connection closed"}
```

**`pnpm scenario:row-protection`:**

```json
{"companyId":7,"msg":"worker A holds pg_advisory_lock for this company - believes it is the only writer 'processing payroll'"}
{"companyId":7,"rowCount":1,"directUpdateDurationMs":1,"msg":"a connection that NEVER called pg_advisory_lock updated the SAME row anyway, instantly, while the lock was held"}
{"companyId":7,"lockHeldByWorkerA":true,"directUpdateRowCount":1,"directUpdateSucceededWhileLockHeld":true,"directUpdateDurationMs":1,"finalStatus":"corrupted-by-bypass"}
```

**`pnpm scenario:lock-key-strategies`:**

```json
{"companyId":7,"acquired":true,"msg":"strategy 1: pg_try_advisory_lock(internal numeric id)"}
{"companyId":7,"publicId":"5470a662-024f-42a3-aa7d-5058c5c8d2c4","key":"1703544086","acquired":true,"msg":"strategy 2: pg_try_advisory_lock(hashtext(public_id)::bigint)"}
{"companyId":7,"publicId":"5470a662-024f-42a3-aa7d-5058c5c8d2c4","key1":-1025306058,"key2":-1493732060,"acquired":true,"msg":"strategy 3: pg_try_advisory_lock(int, int) from md5(public_id) split"}
```

Birthday-paradox collision probability estimates (pure math, `approxCollisionProbability`, not a DB call):

| companies | 32-bit key space | 64-bit key space |
|---|---|---|
| 1,000 | 0.0116% | ~2.7e-12% |
| 100,000 | 68.8% | ~2.7e-8% |
| 10,000,000 | ~100% | ~0.00027% |

At 100,000 companies, hashing a UUID into a 32-bit key already has a
better-than-even chance of colliding with another company's key somewhere in
the set - purely a throughput/availability cost (two unrelated companies
occasionally contend for the same advisory lock and one waits or gets a
false busy signal), never a correctness bug, since nothing about advisory
locks assumes a collision-free key space. The same 100,000 companies hashed
into a 64-bit space (the `pg_try_advisory_lock(int, int)` two-key form, or a
64-bit hash for the single-bigint form) have a collision probability around
2.7e-8% - low enough to treat as effectively zero in practice. Using the
internal numeric `id` directly avoids this tradeoff entirely, at the cost of
requiring every caller to know that id.

`pnpm test` (5 test files, 8 tests) and `pnpm typecheck` both pass cleanly
against this output. The full `docker compose down -v && docker compose up
-d && pnpm db:migrate && pnpm seed && pnpm test` reset flow was also run
from a clean volume and produced the same passing results (with fresh
company ids starting at 1, since the identity sequence restarts along with
the dropped volume).
