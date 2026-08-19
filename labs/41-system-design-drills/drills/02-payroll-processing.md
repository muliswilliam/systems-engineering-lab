# Drill 02 - Payroll processing

## Prompt

Design a payroll processing system for a multi-tenant HR platform:
hundreds of companies, each with its own payroll period (weekly,
biweekly, monthly), each period producing payslips, tax entries, and
deductions for every employee. A payroll run must execute exactly once
per company per period even if the triggering job is retried, one
company's slow or stuck run must not block any other company's run, and
periodic schema changes (new tax fields, new deduction types) must roll
out without downtime while payroll keeps running on a schedule.

Do your own prediction before reading on.

## Model answer

### 1. Invariants

- Exactly one committed payroll run exists per `(company_id, period_id)`
  pair, no matter how many times the triggering scheduler tick fires or
  the run is retried after a crash.
- Two workers never process the same company's payroll run concurrently
  (double-paying every employee in that company).
- A payslip total is never computed against partially-updated employee or
  tax-rate data (a rate change committing mid-calculation must not produce
  a payslip that mixes old and new rates within itself).

### 2. Consistency requirements

**Strong** consistency within one company's run - the run is a
transaction (or a bounded sequence of transactions) that must not be
visible in a half-applied state, and the invariant it protects
("employee's payslip total is correct") often spans more than one row
(gross pay, deductions, employer tax contributions), the same
multi-row-invariant shape Lab 08/09 study directly. **Independence**
across companies - company 5's run state must have zero effect on
company 6's run, which is a modeling/lock-granularity choice, not merely
a consistency level.

### 3. Storage choice

Postgres, payroll domain (`companies`, `employees`, `payroll_runs`,
per Labs 01/02/13's own schema), with `id bigint` internal keys and a
`public_id uuid` exposed externally - exactly Lab 02's own exercise
("model a payroll company with internal bigint IDs and externally exposed
UUID IDs, discuss why systems often use both"): the bigint is what the
advisory-lock key and every internal join use; the UUID is what an
external payroll API or a webhook payload exposes, so internal key
choices (sharding, renumbering) never leak into a public contract.

### 4. Concurrency mechanism

**Per-company isolation while a run executes**: a Postgres advisory
lock keyed on `company_id` - the exact scenario Lab 13 built: worker A
processing company 5 blocks worker B's attempt on company 5, while
worker C's attempt on company 6 proceeds immediately, unaffected. Lab 13
is explicit, and this design repeats the same warning explicitly, that
the advisory lock coordinates *cooperating* workers only - Lab 13 proved
a connection that never calls any `pg_advisory_*` function can still
`UPDATE` the exact row the lock is "protecting" in 1ms, completely
unimpeded. That means the advisory lock is the right tool for
"don't let two payroll-run workers step on each other," but it is *not*
itself the mechanism that makes a payslip total correct - that still
needs the transaction and (where the invariant spans employee/tax-rate
rows) Serializable isolation, below. Per Lab 13's own exercise, the lock
key here is the company's existing internal numeric `id`, not a hash of
its public UUID - no collision-probability tradeoff needs to be accepted
at all, since a stable numeric ID already exists.

**Exactly-once per (company, period)**: a `UNIQUE (company_id,
period_id)` constraint on `payroll_runs`, combined with the same
idempotency-key insert pattern Lab 15 proved: `INSERT ... ON CONFLICT
(company_id, period_id) DO NOTHING RETURNING *`, with a fallback `SELECT`
on conflict. This is the actual guarantee against a retried scheduler
tick or a retried job - not the advisory lock. Lab 15's own numbers (10
concurrent same-key retries producing exactly 1 persisted row,
every caller receiving the identical response) is the direct evidence:
here the "key" is the natural composite `(company_id, period_id)` rather
than a client-supplied key, but the mechanism and guarantee are
identical.

**Cross-row invariants inside a run** (e.g. "total employer tax liability
for the company must reconcile against the sum of individual employee tax
entries" - an invariant that spans many rows, not one): Serializable
isolation with a bounded retry loop, exactly Lab 09's pattern. Lab 09
showed Repeatable Read alone lets two independently-valid-looking
transactions both commit and silently violate a cross-row invariant (the
on-call-staff write-skew anomaly, ending at 0 on-call staff when the
invariant required at least 1); Serializable caught the identical
interleaving with a real `SQLSTATE 40001` on one side, and Lab 09's own
5-way contention benchmark showed the retry cost this buys (11 total
attempts, 6 real conflicts) against the cost of getting it silently wrong
for free (5 attempts, 0 conflicts, wrong answer). A payroll run's own
reconciliation check is exactly this shape of invariant, and paying
Serializable's retry cost once per period, not per request, is a small
price for it.

**Crash recovery for a stuck run**: model the payroll run itself as a
claimable job row (`jobs`/`job_attempts`, Lab 14's schema), claimed via
`SELECT ... FOR UPDATE SKIP LOCKED` with a lease (`locked_until`). Lab
14's own numbers - a job whose worker crashes mid-processing becomes
reclaimable by a different worker in a real measured 15ms past a 300ms
lease, and a job that fails `max_attempts` times moves to a terminal
`failed` status and is never claimed again - map directly onto "a payroll
run worker died partway through; another node must pick it up without
double-paying anyone." The `(company_id, period_id)` uniqueness
constraint above is what prevents that reclaim from producing two
committed runs even if the crashed worker's transaction had, in fact,
already committed and the crash happened only in its post-commit
bookkeeping.

**Bulk backfills** (e.g. recalculating a tax field across a full historical
period for every employee after a rate correction): batched, resumable,
and paced, exactly Lab 30's pattern, not one giant `UPDATE`. Lab 30
measured a single unbatched `UPDATE` across 1,000,000 rows taking
5,456-5,595ms and blocking an unrelated concurrent write to the very same
row for 97.3-97.4% of that entire duration; the batched version (1,000-row
batches, 50ms pacing sleep, a natural `WHERE ... IS NULL`-style
resumability predicate) took longer in total (64,214ms) but reduced a
concurrent write's worst-case latency roughly 80x (p99 20.95ms/max
66.66ms versus a 7.57ms unthrottled baseline) - the correct tradeoff for
a payroll recalculation, which should never make live payslip lookups
hang while it runs. Lab 30 also proved resumability concretely: a real
`SIGKILL` mid-run left 1,800 of 20,000 rows committed, and resuming
completed exactly the remaining 18,200 with zero rows double-processed or
skipped.

### 5. Failure modes

- **Scheduler fires the same period's job twice** (a duplicate cron tick,
  or a retried scheduling call): the `(company_id, period_id)` unique
  constraint plus `ON CONFLICT DO NOTHING` absorbs it for free, per Lab
  15's pattern.
- **Worker crashes mid-run, after acquiring the advisory lock**: the
  advisory lock releases automatically on connection loss (Lab 13's own
  captured behavior - closing a session without an explicit unlock frees
  the key for a new session), so a second worker can retry the company
  without a manual intervention; the uniqueness constraint on
  `payroll_runs` still prevents a double-committed run even if the crash
  happened after commit but before the lock was released.
- **A cross-row reconciliation invariant is violated by two concurrent
  runs on different but related data** (rare, but possible if two workers
  each independently touch overlapping tax-rate rows): Serializable's
  `SQLSTATE 40001` plus a bounded, jittered retry (Lab 09) turns this into
  a correctness guarantee rather than a race.
- **A tax-rate schema change needs to ship while payroll keeps running on
  its normal schedule**: expand/contract (Lab 29) - add the new nullable
  column, deploy code that dual-writes both old and new fields, backfill
  historical rows in batches (Lab 30's own batching pattern), switch
  reads, then drop the old column later; never a blocking `RENAME COLUMN`
  against a live payroll table, which Lab 29 showed breaks any old
  application instance still running with a real captured `SQLSTATE
  42703`.
- **Heavy periodic UPDATE churn on payslip/deduction tables bloats them**:
  Lab 31's own numbers (15 update passes with autovacuum off grew a table
  15.87x, and a bloated table read 14.7x more buffers for the identical
  logical `COUNT`) are the direct argument for leaving autovacuum enabled
  and tuned (not disabled "for performance" during a payroll run), since
  a payroll table is exactly the kind of table that receives many
  UPDATEs in a short window every pay period.

### 6. Scale estimate

Hundreds of companies each running independently via advisory-lock
granularity is the same shape Lab 13 measured directly: a lock held on
company 5 has zero effect on company 6's throughput. The real scaling
question is total worker count needed to drain all due runs within the
payroll window, which is exactly Lab 14's `SKIP LOCKED` job-claiming
math: 50 workers over 250 claimable jobs resolved with zero double-claims
in 125ms in Lab 14's own measurement, so scaling out payroll-run workers
horizontally, with each run modeled as one claimable job, scales the same
way.

### 7. Observability

- Structured logs per run with `companyId`, `periodId`, `workerId`,
  `attempt` (CLAUDE.md's own logging-standard field set, and exactly what
  Lab 13/14's own tests key their assertions on).
- `pg_stat_activity`/`pg_locks` to catch a payroll run whose transaction
  is unexpectedly long-running (a reconciliation query gone wrong) before
  it blocks a concurrent read.
- `pg_stat_user_tables` (`n_dead_tup`, `autovacuum_count`) on the payslip
  and deduction tables, per Lab 31, watched specifically around each
  payroll window.
- A dead-run counter (jobs that hit `max_attempts` and moved to `failed`,
  Lab 14's terminal state) - a payroll run that fails permanently needs a
  human, not a silent retry loop.

## Common wrong answer

**"Use one global mutex/lock (e.g. a single Redis key like
`payroll:lock`) so only one payroll run can ever execute at a time,
avoiding any chance of a double-run."** This is wrong for a reason
different from Drill 01's wrong answer: it is not unsafe, it is simply
the wrong granularity, and it destroys the entire point of running
payroll for hundreds of independent companies - Lab 13 exists precisely
to demonstrate that the correct lock granularity is per-company (`company
5` vs `company 6`), not global, and that a global lock would serialize
every company's payroll behind every other company's, turning an
embarrassingly parallel batch job into a strictly sequential one for no
correctness benefit. The actual "never run this twice" guarantee should
not even come from the lock at all - it comes from the
`(company_id, period_id)` unique constraint (Lab 15's pattern), which
holds even if the lock is never acquired (a bug, a crash before the lock
call, a worker that ignores the lock entirely).

## Interview questions

- Why does this design use both an advisory lock AND a unique constraint,
  when either one, on paper, sounds like it could prevent a duplicate
  run? What does each one actually protect that the other does not?
- A payroll run for company 40 has been "in progress" for six hours,
  far longer than every other company's run. Walk through, using Lab
  13/14's own mechanisms, how you would detect and safely recover this
  without risking a double payment.
- Why is `company_id` (a stable internal bigint) preferred over hashing
  the company's public UUID for the advisory lock key here, when Lab 13
  shows the hashed-UUID approach is also viable?
- The tax-rate reconciliation invariant spans many employee rows within
  one company. Why is Serializable isolation used only for that specific
  check, and not for the entire payroll run end to end?
- If this platform grew from hundreds of companies to hundreds of
  thousands, what would change first - the lock mechanism, the job-queue
  worker count, or something else entirely?
