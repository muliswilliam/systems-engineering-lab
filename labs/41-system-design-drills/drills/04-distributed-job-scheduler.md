# Drill 04 - Distributed job scheduler

## Prompt

Design a job scheduler that fires recurring jobs (cron-like schedules,
e.g. "every hour," "every day at 02:00") and one-off delayed jobs (e.g.
"run in 30 minutes"). Multiple scheduler processes run for availability,
but a job must fire the right number of times - not skipped because the
process that was supposed to fire it crashed, and not duplicated because
two scheduler replicas both decided to fire it. Jobs call external
services that are sometimes slow or down.

Do your own prediction before reading on.

## Model answer

### 1. Invariants

- For each `(schedule_id, scheduled_for)` tick, exactly one job row is
  ever enqueued, no matter how many scheduler replicas are evaluating
  that schedule concurrently.
- An enqueued job is claimed and executed by exactly one worker at a
  time; a worker crash mid-execution does not lose the job (it becomes
  reclaimable) and does not let a second worker execute it *concurrently*
  with the first (only sequentially, after the first is confirmed dead).
- A job that fails is retried a bounded number of times, then reaches a
  terminal failed state that a human can act on - it never retries
  forever, and it is never silently dropped.

### 2. Consistency requirements

The jobs table itself needs to be the durable, strongly-consistent
source of truth for "what is due and what has fired" - a scheduler
replica's own in-memory timer state must never be authoritative, because
that state disappears exactly when the process crashes, which is
precisely when the guarantee matters most.

### 3. Storage choice

Postgres, background-processing domain (`jobs` + `job_attempts`, Lab
14's own schema - no separate `workers` table, since workers are
ephemeral and identified only by a `worker_id` string, exactly Lab 14's
own documented scoping decision) plus a `schedules` table describing each
recurring definition and its next-fire computation.

### 4. Concurrency mechanism

**Multiple scheduler replicas evaluating the same schedule without a
leader election**: rather than electing one leader scheduler (extra
coordination machinery this drill does not need), let every replica
independently compute "is `schedule_id` due for `scheduled_for`" and
attempt `INSERT INTO jobs (schedule_id, scheduled_for, ...) ... ON
CONFLICT (schedule_id, scheduled_for) DO NOTHING` - Lab 15's idempotent-
insert pattern applied to scheduling itself, with the composite
`(schedule_id, scheduled_for)` acting as the idempotency key. Whichever
replica's insert wins is irrelevant; every other replica's identical
attempt is a harmless no-op. This sidesteps needing an advisory lock or
leader election entirely, because the invariant ("this tick fires
exactly once") is expressible as a single-row uniqueness constraint, the
same "keep the guarantee close to the data" principle Lab 15 teaches for
request-level idempotency.

**Worker job claiming**: `SELECT ... FROM jobs WHERE status = 'pending'
... FOR UPDATE SKIP LOCKED LIMIT 1`, exactly Lab 14's mechanism. Lab 14
measured this directly at three worker counts: 5 workers over 100 jobs
each claimed exactly 20 (71ms), and 50 workers over 250 jobs each claimed
exactly 5 with zero double-claims (125ms) - this is the real evidence
that adding scheduler-side worker capacity scales the claiming step
without a coordinator, and Lab 14's own direct comparison (a plain `FOR
UPDATE` blocking a second worker for 312ms behind the first worker's lock
versus `SKIP LOCKED` resolving in 10ms by moving to a different row) is
the reason `SKIP LOCKED`, not a plain row lock, is the claiming
mechanism here: a scheduler's worker pool should never have one worker
sit blocked behind another for a job it was never going to get anyway.

**Crash recovery**: a `locked_until` lease column, Lab 14's own pattern -
a job whose worker crashes (never marks it complete, never extends the
lease) becomes reclaimable by a different worker once the lease expires,
measured at a real 15ms reclaim latency past a 300ms lease in Lab 14's
own test. Bounded retries via `attempts`/`max_attempts` move a job to a
terminal `failed` status after repeated failures (Lab 14's own 3-attempt
example) and it is never claimed again - the mechanism that prevents
"retries forever" from the invariants above.

**Calling the external service the job triggers**: Lab 37's full
composition (circuit breaker outermost, retry-with-jittered-backoff
inside it, per-attempt timeout innermost) - Lab 37's own retry-storm
evidence (50 concurrent callers x 5 retries against a fully-down
downstream producing exactly 250 real calls and zero successes) is the
direct argument against a job's own retry logic hammering a downstream
with no backoff, and its circuit-breaker evidence (a breaker tripped
after exactly 5 consecutive failures, after which every further call
cost 0ms instead of 19-28ms of a real attempted call) is the argument for
stopping calls to a downstream that is clearly, structurally down rather
than continuing to spend the job worker pool's time on doomed attempts.

### 5. Failure modes

- **Two scheduler replicas evaluate the same due tick within the same
  millisecond**: the `(schedule_id, scheduled_for)` unique constraint
  plus `ON CONFLICT DO NOTHING` absorbs it - one insert wins, the other
  is a silent no-op, no coordination round trip needed before either
  attempt.
- **A worker crashes mid-job**: the lease (`locked_until`) expires and a
  different worker reclaims it (Lab 14's own 15ms-past-300ms-lease
  measurement) - the job fires again, which is why job handlers in this
  design must themselves be idempotent or the retried execution must be
  safe to repeat (the scheduler guarantees at-least-once execution per
  claimed job attempt, not exactly-once side effects - the same
  "exactly-once is composed, not free" lesson Lab 19 teaches).
- **A job's own external call is down for an extended period**: bounded
  retries plus a circuit breaker (Lab 37) stop the job from consuming a
  worker slot indefinitely; the job eventually reaches `failed` and
  alerts, rather than occupying a worker forever.
- **A schedule's next-fire computation has a bug that enqueues the same
  tick many times before the fix ships**: the uniqueness constraint
  bounds the damage to "duplicate insert attempts are all harmless
  no-ops," not "the job actually runs many times" - a direct benefit of
  putting the guarantee in the datastore rather than trusting the
  scheduling logic to compute correctly every time.

### 6. Scale estimate

The claiming step is the part under real concurrent load (many workers,
one `jobs` table), and Lab 14's own numbers are the direct evidence for
how it scales: worker count scaling from 5 to 50 kept per-worker claim
correctness exact (zero double-claims at either scale) while wall-clock
time for draining a fixed job count dropped, because losing a claim race
under `SKIP LOCKED` costs a worker roughly 10ms, not the 312ms a losing
worker would pay under a plain `FOR UPDATE` queue.

### 7. Observability

- Queue depth (pending job count) and dead-job count (`failed` status) -
  a scheduler with a growing pending count and a growing dead count is
  falling behind and needs paging, not just logging.
- Per-job structured fields: `workerId`, `jobId`, `attempt`,
  `scheduledFor`, `claimedAt` (CLAUDE.md's own logging-standard field
  set, mirroring Lab 14's own test assertions).
- Circuit breaker state per external service a job calls, plus the same
  `notificationCallsMade`/`circuitOpenRejections`-shaped counters Lab 40
  used for its own downstream calls.

## Common wrong answer

**"Elect a single leader scheduler process (e.g. via a Redis lock held
for the scheduler's lifetime) and have only the leader ever enqueue
jobs, to guarantee no duplicates."** This is not unsafe by itself, but it
reintroduces exactly the distributed-lock failure mode Lab 22 measured
directly (a lease held past its TTL by a paused or slow process lets a
second holder believe it also holds the lock - Lab 22's own real captured
overlap: a worker still believing it held a 200ms-TTL lock wrote at
401ms while a second worker had already acquired the "same" lock at
261ms) to solve a problem that does not need leader election at all: the
uniqueness constraint on `(schedule_id, scheduled_for)` already makes
"every scheduler replica independently attempts the insert" perfectly
safe without ever electing a leader, run a heartbeat, or handle a
split-brain window during leader handoff. Leader election is real,
necessary machinery for problems that genuinely require a single
decision-maker (this curriculum does not build one, and Lab 28 explicitly
scopes failover/promotion decisions as "normally automated by tools this
curriculum does not build from scratch") - but "don't enqueue the same
tick twice" is not such a problem once it is expressed as a uniqueness
constraint.

## Interview questions

- Why does this design avoid leader election entirely, and what property
  of the invariant (not the tooling) makes that possible?
- A job's external call succeeds, but the worker crashes before marking
  the job complete. What happens next, and why must the job handler
  itself be written to tolerate this?
- Compare this scheduler's `SKIP LOCKED` claiming to Lab 17's outbox
  worker claiming. What is the same, and what is different about what
  each is claiming?
- Why is `max_attempts` combined with a terminal `failed` status
  necessary even when every downstream call already has a circuit
  breaker in front of it?
- If this scheduler needed sub-second-precision firing (not just
  minute/hour granularity), what would need to change about the claiming
  mechanism, and would `SKIP LOCKED` still be the right fit?
