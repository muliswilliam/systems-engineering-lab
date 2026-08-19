# Lab 14 - PostgreSQL Job Queue with `SKIP LOCKED`

## Why this exists

A background job queue needs many worker processes pulling work off one
shared table without ever handing the same job to two workers at once - and
without workers standing in line behind each other just because they all
looked at the queue at the same moment. A naive `SELECT ... FOR UPDATE LIMIT
1` solves the "never hand out the same job twice" problem, but at the cost of
serializing every worker behind whichever one happened to lock the first
candidate row first. Postgres has a purpose-built answer: `FOR UPDATE SKIP
LOCKED`. This lab builds a real job queue - claim, process, complete, retry,
terminal failure, and a processing lease that recovers work from a crashed
worker - and proves, with 1, 5, and 50 real concurrent workers against a real
Postgres instance, that `SKIP LOCKED` distributes jobs across workers instead
of queueing them up.

## Learning objectives

After this lab you should be able to:

- write and explain the exact claim query - `SELECT ... FOR UPDATE SKIP
  LOCKED LIMIT 1` inside a transaction that also marks the row claimed -
  and why doing the SELECT and the UPDATE in one transaction is what makes
  the claim atomic;
- explain, with a real measured number, why plain `FOR UPDATE` (no `SKIP
  LOCKED`) makes a second worker block behind the first worker's lock even
  when other unlocked rows exist, and why `SKIP LOCKED` does not;
- design a processing lease (`locked_until`) that lets a job claimed by a
  worker that then crashes or hangs become reclaimable by a different worker,
  without any heartbeat or external coordinator;
- implement bounded retries with a terminal failure state, and explain why
  the terminal state must be permanently excluded from the claim query;
- state the actual "no double processing" invariant precisely enough to test
  it directly against the audit table, not just against worker-reported
  results.

## Architecture

```text
jobs                                    job_attempts
├── id, public_id                       ├── id
├── job_type, payload (jsonb)           ├── job_id -> jobs.id
├── status: pending|processing|         ├── worker_id
│           completed|failed            ├── attempt_number
├── attempts, max_attempts              ├── status: claimed|completed|
├── locked_by, locked_until  <────┐     │           failed|expired
├── last_error                    │     ├── claimed_at, released_at
└── created_at, updated_at        │     └── error
                                   │
                     the lease: a worker that never clears
                     locked_by/locked_until (crash/hang) leaves
                     the job reclaimable once locked_until < now()
```

Domain: **background processing** (SPEC.md 8.2), new in this lab.
`packages/data-generators/src/jobs.ts` provides the reusable
`generateJobs(count, seed, failureRate)` generator (5 realistic job types -
`send_email`, `generate_report`, `resize_image`, `process_payment`,
`sync_inventory` - each with a type-appropriate payload). `job_attempts` is
scenario-specific to this lab (it records this lab's own claim/lease/retry
bookkeeping) and is defined only in this lab's schema, per CLAUDE.md's
guidance not to build speculative shared machinery ahead of a second
consumer needing it.

**Why no `workers` table?** SPEC.md's Lab 14 section lists `jobs`, `workers`,
`job_attempts`. This lab deliberately does not persist a `workers` table.
Workers here are ephemeral processes/async loops (`runWorkerUntilEmpty` in
`src/queue/worker.ts`), identified only by a `worker_id` string
(`"worker-3"`) - a real worker fleet's processes come and go with deploys and
autoscaling, and nothing in this lab's queue semantics needs a durable row
per worker (no per-worker configuration, no worker-to-worker relationships,
no worker health table beyond "is this job's lease still valid"). `job_id` +
`worker_id` on `job_attempts` is enough to answer every question this lab
asks: which worker claimed which job, when, and what happened. A `workers`
table would only be worth adding if a later lab needed persistent per-worker
state (rate limits, worker-specific concurrency caps, a worker registry for
an operator UI) - none of which this lab needs.

**The claim query** (`src/queue/claim.ts`), extending SPEC.md's shape with
the lease-expiry branch:

```sql
SELECT id, status
FROM jobs
WHERE status = 'pending'
   OR (status = 'processing' AND locked_until < now())
ORDER BY created_at
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

followed, in the same transaction, by an `UPDATE jobs SET status =
'processing', locked_by = $1, locked_until = now() + lease, attempts =
attempts + 1 ...` and an `INSERT INTO job_attempts (...) VALUES (..., 'claimed', ...)`.
Both the naive contrast query (`src/queue/naive-claim.ts`, plain `FOR UPDATE`)
and the real claim query use raw `pg` SQL directly, not Drizzle's query
builder - per CLAUDE.md's "ORM plus SQL" principle, `FOR UPDATE SKIP LOCKED`
is exactly the kind of lock behavior that should be visible as literal SQL.
Schema definition and migrations still use Drizzle.

## Setup

```bash
pnpm install
cp labs/14-job-queue-skip-locked/.env.example labs/14-job-queue-skip-locked/.env
cd labs/14-job-queue-skip-locked
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate
pnpm seed --seed=42 --size=small    # 20 jobs, for the single/five-worker demos
```

Open PGweb at http://localhost:8414 (auto-connects via
`PGWEB_DATABASE_URL`). You should see 20 rows in `jobs`, all `status =
'pending'`, and an empty `job_attempts` table.

## Scenario

A background-jobs table (`send_email`, `generate_report`, `resize_image`,
`process_payment`, `sync_inventory` jobs) needs to be drained by a pool of
worker processes running concurrently, in production, on autoscaled
infrastructure where any worker can be killed or hang at any time. The
invariants that must hold no matter how many workers are running:

> Every job is claimed by at most one worker at any instant - never two
> workers processing the same job concurrently.

> Every job that can succeed eventually gets marked `completed`, exactly
> once - no job is silently skipped.

> A job that keeps failing eventually stops being retried and is excluded
> from all future claims.

> A job whose worker crashes or hangs without finishing it does not stay
> stuck forever - another worker eventually reclaims it.

## Prediction

Before running anything, predict:

1. Two workers both run `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1` at
   nearly the same instant against a queue of 10 pending jobs. Can they ever
   both end up trying to process the same job? What in Postgres prevents it?
2. Now imagine the same two workers running plain `SELECT ... FOR UPDATE
   LIMIT 1` (no `SKIP LOCKED`) instead. What happens to the second worker's
   query while the first worker's transaction is still open? Does it try a
   different row, or wait?
3. A worker claims a job, sets `locked_until` 30 seconds in the future, then
   the process is killed by the orchestrator before it calls complete or
   fail. What is the job's `status` immediately after the kill? What happens
   to it 30 seconds later?
4. A job has `max_attempts = 3` and always fails. After the 3rd failed
   attempt, what does the claim query do differently for this job compared
   to before the 3rd attempt?

## Exercise

1. Run the setup commands above.
2. Run the single-worker baseline:
   ```bash
   pnpm scenario:single
   ```
3. Reseed at a size with more jobs and run 5 concurrent workers:
   ```bash
   pnpm seed --seed=42 --size=medium
   pnpm scenario:five
   ```
4. Reseed at the largest size and run 50 concurrent workers:
   ```bash
   pnpm seed --seed=42 --size=large
   pnpm scenario:fifty
   ```
5. Run the retries-and-terminal-failure demo (inserts its own always-failing
   job, independent of whatever `pnpm seed` left in the table):
   ```bash
   pnpm scenario:retries
   ```
6. Run the lease-expiry-and-reclaim demo:
   ```bash
   pnpm scenario:lease
   ```
7. Run `pnpm test` and read through `tests/integration/` - these assert the
   exact invariants above as real, automated checks, including the 5- and
   50-worker draining scenarios running inside the test suite itself.

## Observe

- **PGweb** (http://localhost:8414): after `pnpm scenario:five` or
  `pnpm scenario:fifty`, every row in `jobs` should be `status = 'completed'`
  and `job_attempts` should have exactly one row per job. Filter
  `job_attempts` by `worker_id` to see each worker's share of the work.
- **`docker compose logs postgres`**: `log_statement=all` makes the literal
  `SELECT ... FOR UPDATE SKIP LOCKED`, the claiming `UPDATE`, and the
  `job_attempts` `INSERT` visible for every single claim - compare the
  volume and pattern of statements between `scenario:single` and
  `scenario:fifty`.
- **Structured logs**: every scenario logs through `@labs/logging` (Pino)
  with `workerId`, `jobId`, `attempt`, and `reclaimed` fields on every claim,
  so which worker did what is a field in the log line, not something you
  have to reconstruct.
- **`SELECT status, locked_by, locked_until FROM jobs WHERE status = 'processing' AND locked_until < now();`**
  - in production, this is exactly the query that would find jobs stuck
  behind a crashed worker that the claim query hasn't yet picked back up
  (it should always return 0 rows in a healthy system with active workers).

## Break it

Plain `FOR UPDATE` (no `SKIP LOCKED`) does not distribute work across
workers - it serializes them. `tests/integration/for-update-vs-skip-locked.test.ts`
proves this with a real measured wait, using `src/queue/naive-claim.ts` (a
second, deliberately worse claim query used only by this test):

Real captured output from this lab's own validation run:

```text
[plain FOR UPDATE test] second claim blocked for 312ms
✓ plain FOR UPDATE: a second worker blocks until the first worker's
  transaction ends, even with other jobs free  328ms
```

The test holds a transaction open on one connection after running `SELECT
id FROM jobs WHERE status = 'pending' ORDER BY created_at FOR UPDATE LIMIT
1` (no commit yet), then starts a second, independent claim on a different
connection using the exact same query shape. The second call does not look
at any of the other 4 pending jobs in the test's batch - it blocks, for the
full ~300ms the first transaction stays open, trying to lock the *same* row
the first transaction already holds. Once the first transaction commits, the
second call's blocked `SELECT` finally returns - and by then that specific
row is no longer `'pending'` (the first worker already claimed it), so the
naive claim finds nothing new; the 300ms was spent entirely waiting, not
working.

## Fix it

The same scenario with `FOR UPDATE SKIP LOCKED` instead:

```text
[SKIP LOCKED test] second claim resolved in 10ms (no blocking)
✓ FOR UPDATE SKIP LOCKED: a second worker claims a DIFFERENT row
  immediately instead of blocking  (part of the 375ms test file)
```

With the first transaction still holding its lock on the same first
candidate row, the second worker's `claimJob` call (the real production
claim query) returns in 10ms with a *different* job id - it skipped the
locked row and moved straight to the next unlocked candidate, instead of
waiting for the first transaction to finish.

Real captured output from the three worker-count scenarios (seed 42):

```text
$ pnpm seed --size=small && pnpm scenario:single      # 20 jobs, 1 worker
claimed: 20   completed: 20   wallClockMs: 50
byStatus: [{ status: "completed", count: 20 }]

$ pnpm seed --size=medium && pnpm scenario:five       # 100 jobs, 5 workers
claimCounts: worker-1..5 each claimed 20
totalClaimed: 100   uniqueClaimed: 100   wallClockMs: 71
byStatus: [{ status: "completed", count: 100 }]

$ pnpm seed --size=large && pnpm scenario:fifty       # 250 jobs, 50 workers
claimCounts: worker-1..50 each claimed 5 (min: 5, max: 5, zero-claim workers: 0)
totalClaimed: 250   uniqueClaimed: 250   wallClockMs: 125
byStatus: [{ status: "completed", count: 250 }]
```

At 5 workers over 100 jobs, the distribution is perfectly even (20 each) -
`ORDER BY created_at` plus `SKIP LOCKED` naturally load-balances because
every worker races for the *oldest* remaining unlocked job, and whichever
worker is momentarily faster just takes the next one instead of waiting. At
50 workers over 250 jobs the same thing holds at 10x the concurrency: every
worker claimed exactly 5 jobs, `uniqueClaimed` (250) equals `totalClaimed`
(250) - no job was ever claimed twice - and the whole queue drained in
125ms wall clock (a *qualitative* data point, not an assertion, per SPEC.md
section 11 - see "Further experiments" for scaling this up).

`pnpm test`'s own 50-worker integration test (`tests/integration/draining.test.ts`,
a fresh 200-job batch, isolated from the scenario scripts' shared seed data)
captured:

```text
[50-worker test] wall clock: 94ms, jobs: 200
✓ tests/integration/draining.test.ts (3 tests) 207ms

Test Files  5 passed (5)
     Tests  9 passed (9)
```

## Why the fix works

`FOR UPDATE` acquires a row lock on the row(s) a `SELECT` selects, and if
another transaction already holds that lock, the acquiring transaction
blocks until it's released - this is the same row-locking behavior Lab 10
covers, just triggered by a plain read-then-decide query instead of an
`UPDATE`. `SKIP LOCKED` changes only one thing: instead of blocking when a
candidate row is already locked, Postgres removes that row from
consideration and moves on to the next matching row. With `ORDER BY
created_at LIMIT 1`, that is the difference between "every worker fights
over the same first row, one at a time" and "every worker gets whichever
row nobody else currently holds."

Combining the `SELECT ... FOR UPDATE SKIP LOCKED`, the `UPDATE` that marks
the job `'processing'`, and the `INSERT` of the `job_attempts` row inside one
transaction is what makes the whole claim atomic: no other transaction can
see this job as `'pending'` (or lease-expired `'processing'`) again until
this transaction commits or rolls back. That single-transaction claim is the
entire correctness mechanism - there is no advisory lock, no external mutex,
no coordinator service. Postgres's own row lock is the only thing
preventing two workers from claiming the same job, which is exactly
CLAUDE.md's "prefer datastore-native guarantees" principle in action.

The lease (`locked_until`) exists because a transaction's row lock is
released the instant that transaction ends - it says nothing about whether
the *worker* that claimed the job is still alive after its claiming
transaction committed. A worker can crash seconds or minutes after
successfully claiming a job, with nothing left holding any lock at all. The
claim query's second branch (`status = 'processing' AND locked_until <
now()`) is a purely time-based, no-heartbeat-required way to notice this: no
process needs to detect the crash for the job to become reclaimable again,
`now() > locked_until` is enough.

## Tradeoffs

- **`SKIP LOCKED` gives up strict FIFO ordering.** A worker that skips a
  locked row may end up processing a newer job before an older one that
  happens to be locked at that instant. For most job queues this is an
  acceptable tradeoff (throughput and non-blocking claims matter more than
  perfect ordering); if your queue genuinely needs strict ordering, `SKIP
  LOCKED` is the wrong tool.
- **The lease duration is a real tuning knob with a real failure mode in
  both directions.** Too short, and a slow-but-still-alive worker can have
  its in-progress job reclaimed by another worker while it is still working
  on it (see `playground/notes.md` for an experiment lowering it to 50ms).
  Too long, and a genuinely crashed worker's job sits unclaimed for the
  full lease duration before anyone else can pick it up. There is no lease
  duration that is simultaneously "instant recovery" and "never falsely
  reclaims a slow worker" - production systems typically also make workers
  extend/renew their own lease periodically (a heartbeat) for long-running
  jobs, which this lab does not implement (see "Further experiments").
- **A reclaimed job can, in principle, still be processed twice** if the
  original "crashed" worker was not actually dead - just slow or paused
  (e.g. a long GC pause) - and resumes after its lease expired and another
  worker already reclaimed and started the same job. This is exactly the
  "fencing token" problem Lab 22 (Redis leases) covers in more depth: a
  lease alone tells a *new* claimant it's safe to proceed, but does not by
  itself stop a *former* lease-holder from continuing to act as if it still
  owns the job. Mitigation is job-type-dependent: make the job's actual side
  effect idempotent (Lab 15), or have the resuming worker re-check its own
  claim is still current before doing anything externally visible.
- **Bounded retries with a fixed `max_attempts` treat every failure the
  same.** This lab's `failJob` does not distinguish a transient failure
  (worth retrying) from a permanent one (pointless to retry, e.g. malformed
  payload) - real systems often classify errors and skip straight to
  terminal `failed` for the latter, and add backoff between retries for the
  former (this lab retries immediately - see "Further experiments").

## Production notes

1. **What guarantee does this technique provide?** Two workers can never
   both hold an active claim (`status = 'processing'` within its lease) on
   the same job at the same time - Postgres's row lock inside one
   transaction enforces this, not application logic. A job that fails
   `max_attempts` times is permanently excluded from future claims. A job
   whose worker never releases it becomes reclaimable once its lease
   expires, with no external health-check process required.
2. **What does it not guarantee?** That a job's actual side effect (sending
   the email, charging the payment) happens exactly once - if a worker
   completes the real-world side effect and then crashes before calling
   `completeJob`, the lease will expire and another worker will redo the
   side effect. That is an idempotency problem (Lab 15), not a queue-claim
   problem. It also does not guarantee ordering beyond "oldest unlocked job
   first" (see Tradeoffs).
3. **What breaks under process crash?** Before a claim's transaction
   commits: nothing - Postgres rolls back the whole claim automatically, the
   job is untouched. After commit but before `completeJob`/`failJob`: the
   job sits at `'processing'` until its lease expires, at which point it is
   reclaimable - this is the entire point of the lease mechanism, and
   `tests/integration/lease-expiry.test.ts` proves it recovers.
4. **What breaks under network partition?** A worker partitioned from
   Postgres after claiming a job cannot renew its lease or call
   complete/fail - from the database's point of view this is
   indistinguishable from a crash, and the lease-expiry mechanism handles it
   identically. If the partition heals and the worker resumes without ever
   noticing it lost its claim, see the fencing-token caveat under
   Tradeoffs.
5. **What changes at high contention?** This lab measured 50 workers over
   250 jobs completing in 125ms (scenario) / 94ms (200-job test) wall clock,
   with a perfectly even 5-jobs-per-worker distribution and zero double
   claims - `SKIP LOCKED` scales because contention only costs a skip, never
   a wait. At far higher worker counts than jobs remaining, most claim
   attempts return "nothing to claim" quickly; the `jobs_status_created_at_idx`
   composite index keeps the claim query an index scan instead of a
   sequential scan as the table grows.
6. **What changes with multiple regions?** Not applicable yet - single
   Postgres node. A multi-region job queue needs a single authoritative
   claim point (this pattern does not generalize to two independent
   Postgres instances claiming from logically the same queue without an
   additional coordination layer).
7. **What metrics would you monitor?** Count and age of jobs at `status =
   'processing' AND locked_until < now()` (should be ~0 in a healthy system
   with workers running; nonzero and growing means workers are crashing
   faster than the fleet is claiming); count of jobs at `status = 'failed'`
   over time; per-job `attempts` distribution; claim latency (`p50`/`p99` of
   how long the claim query itself takes); queue depth (`count(*) WHERE
   status = 'pending'`).
8. **What simpler alternative could be used?** For very low job volume or a
   single-worker system, a plain `FOR UPDATE` (no `SKIP LOCKED`) is fine -
   the whole point of `SKIP LOCKED` is avoiding contention among *multiple*
   concurrent claimants, which does not exist with one worker. For jobs that
   need strict per-key ordering (e.g. "never process two events for the same
   `order_id` out of order"), an advisory lock keyed on that column (Lab 13)
   composed with `SKIP LOCKED` for cross-key parallelism is a common
   pattern this lab does not implement.
9. **When should you avoid this technique?** When jobs must be processed in
   strict global order (SKIP LOCKED explicitly gives that up), or when job
   volume is so low that a queue table is unnecessary machinery compared to
   just calling the work synchronously.

## Interview questions

1. Walk through, statement by statement, what happens if two workers run
   `claimJob` at literally the same instant against a queue with only one
   pending job. Which one gets it, and what does the other one see?
2. Why does `FOR UPDATE` alone (no `SKIP LOCKED`) fail to distribute work
   across workers, even though it does successfully prevent two workers from
   claiming the same row? What specifically does `SKIP LOCKED` change?
3. Why is the lease (`locked_until`) checked with a plain timestamp
   comparison instead of, say, an advisory lock or a Redis TTL? What would
   an advisory lock not give you here that the lease does (hint: think about
   what happens if the worker process itself, not just its transaction, is
   what fails)?
4. A job has been retried twice and failed both times, with `max_attempts =
   3`. Walk through exactly what the third failed attempt does differently
   from the first two, at the SQL level.
5. Why can a job that already had its real-world side effect completed
   still get reclaimed and reprocessed by another worker? What has to be
   true for that to actually cause a problem, and what fixes it?
6. If you inherited a job-queue table using plain `SELECT ... FOR UPDATE
   LIMIT 1` (no `SKIP LOCKED`) in production, and were told "throughput
   drops off a cliff past ~10 concurrent workers," what would you check
   first, and what would you expect to see in `pg_locks`?

## Further experiments

- Change `LEASE_MS` in `src/scenarios/lease-expiry-reclaim.ts` down to 50ms
  or up to several seconds and rerun - confirm the mechanism still works at
  either extreme, then think through the tradeoff each direction makes
  (see `playground/notes.md`).
- Add a worker-side heartbeat that extends `locked_until` periodically while
  a long-running job is still genuinely in progress, and test that a slow
  (not crashed) worker's job is never falsely reclaimed out from under it.
- Add exponential backoff between retry attempts (e.g. store a
  `next_retry_at` column, or extend `locked_until`'s semantics to also gate
  retries) instead of this lab's immediate-retry `failJob`.
- Increase `tests/integration/draining.test.ts`'s 50-worker test to 500
  workers over 2,000 jobs and see whether the even-distribution property
  and wall-clock time hold up, and at what point Postgres connection limits
  (not `SKIP LOCKED` itself) become the bottleneck.
- Compose this lab's claim query with an advisory lock (Lab 13) keyed on a
  business column (e.g. never process two jobs for the same `orderId`
  concurrently, even across different job rows) and test that it still
  parallelizes across *different* keys while serializing within one key.
- Read `src/queue/naive-claim.ts` and `tests/integration/for-update-vs-skip-locked.test.ts`
  closely, then try the same contrast with a much larger pending-job batch
  (e.g. 1,000 rows) and more concurrent naive claimers - watch `pg_locks`
  and `pg_stat_activity` while it runs to see the queue of blocked backends
  directly.
