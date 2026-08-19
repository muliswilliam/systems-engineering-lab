# Drill 08 - Large multi-region SaaS backend

## Prompt

Design the backend for a large multi-tenant SaaS product with customers
spread across multiple geographic regions. Requirements: low read latency
for users near each region, strict tenant data isolation (tenant A must
never see tenant B's data under any code path, including bugs), the
ability to survive a regional database failure, schema changes that roll
out gradually across a fleet of application servers, and large audit/
activity tables that must stay queryable as they grow into the billions
of rows.

Do your own prediction before reading on.

## Model answer

### 1. Invariants

- No query, under any application bug, returns another tenant's row -
  tenant isolation is a property of the *datastore*, not of every
  application code path remembering a `WHERE tenant_id = ?` clause.
- A write acknowledged to a user is never silently lost on a regional
  primary failure, and a user's own immediate read-after-write is never
  stale, even though other, unrelated reads may tolerate staleness.
- A schema change never breaks an old application version still running
  somewhere in the fleet during a gradual, multi-region rollout.

### 2. Consistency requirements

Per-operation, not global: **ordinary reads** (dashboards, list views not
immediately following the viewer's own write) tolerate eventual
consistency from a regional replica; **read-after-write and transactional
reads** require strong consistency against the primary; **writes** always
go to the tenant's home-region primary. This is exactly Lab 25's own
`classify(kind)` routing table generalized from a single-region
primary/replica pair to a multi-region topology - the classification
axis (what *kind* of operation this is) does not change just because the
topology grew more nodes.

### 3. Storage choice

Postgres, one primary per region (or per group of nearby regions, if a
tenant's home region is itself a data-residency assignment) with local
read-replica fan-out inside each region, and cascading replicas (Lab
27's `primary -> replica-a -> {replica-a1, replica-a2}` topology) where a
single region's read fan-out itself grows large enough that a flat
primary-to-many-replicas topology would overload the regional primary's
own WAL-sender capacity. Every regional Postgres node sits behind
PgBouncer in transaction-pooling mode (Lab 23), because application-
server fleet size at this scale makes direct per-server connections to
Postgres the first thing to exhaust `max_connections` - Lab 23 measured
this exact failure directly (50 concurrent direct connections against a
lowered `max_connections=30`: 29 succeeded, 21 real `SQLSTATE 53300`
rejections) and its fix (the identical burst through a pooled
`default_pool_size=10` PgBouncer: 60 concurrent clients, zero
rejections, peak real backend count never exceeding 10).

### 4. Concurrency mechanism

**Tenant isolation as a datastore-enforced invariant, not an application
convention**: Postgres Row-Level Security with a `tenant_isolation`
policy keyed off a session-local `current_tenant_id()`, and critically,
`FORCE ROW LEVEL SECURITY` enabled - Lab 39's own real evidence is the
direct justification for both halves of this. Without RLS at all, Lab 39
reproduced two distinct real leak classes against a real `lab39_app`
connection: a forgotten `WHERE tenant_id = ?` clause returned
`rowsBelongingToOtherTenants: 97500` out of 100,000 seeded rows to a
single-tenant-scoped request, and a syntactically-valid-but-wrong-value
`WHERE tenant_id = <wrong tenant>` clause returned exactly the wrong
tenant's full 2,500 rows - two genuinely different bug shapes, both real,
neither one a "forgot to test" edge case. With RLS enabled and the same
two buggy queries replayed unmodified, both leaks measured
`rowsBelongingToOtherTenants: 0`, and a session with no tenant context
set at all also saw 0 rows (fails closed). The `FORCE` half matters
specifically because Lab 39 also demonstrated, concretely, the real-world
misconfiguration this design must not repeat: without `FORCE ROW LEVEL
SECURITY`, the table owner/migration role sees every tenant's rows with
no tenant session set at all (`total: 100000, distinct_tenants: 40`)
purely by virtue of owning the table, not by being a superuser - and an
application role that is ever granted table ownership (a common mistake
when a single role does both migrations and application queries) would
silently inherit this bypass.

**Read/write/read-after-write routing, per region**: Lab 25's
`classify(kind)` routing table, and specifically Lab 26's LSN-gated
strategy for correctness-critical read-after-write, not a fixed sleep -
Lab 26 measured the LSN-gated wait (poll the replica's own
`pg_last_wal_replay_lsn()` until it reaches the primary's LSN at write
time) adapting to real replication state: an average wait of 403.2ms
under a genuinely configured 400ms lag, and just 0.4ms with no lag, both
with 15/15 correct reads. The alternative Lab 26 also measured (a fixed
"sticky primary" window) has a documented, real failure mode this design
explicitly avoids relying on alone: a too-short 250ms sticky window
against a real 400ms lag reproduced a genuine stale read even after the
window "expired," because the window's duration is a guess, not a
measurement of actual replication state.

**Monitoring replication lag correctly**: `pg_wal_lsn_diff`-based byte
backlog, not `pg_stat_replication.replay_lag`'s interval column - Lab
26's own real, worth-repeating gotcha: `replay_lag` badly under-reported
lag while `recovery_min_apply_delay` was actively withholding replay
confirmation (climbing only 0.86ms -> 51ms across a window that should
have shown roughly 400ms), which is exactly the kind of dashboard that
would tell an on-call engineer everything is fine during an active
staleness incident. A byte-based backlog metric reacted correctly and
immediately in the same test.

**Surviving a regional primary failure**: `pg_promote()`-based promotion
of an in-region replica, Lab 28's exact mechanism - Lab 28 measured a
real promotion at 110.81ms and a total honest write-unavailability
window (from confirmed primary loss to the first successful write
anywhere) of 124.51ms, explicitly documented as a best-case number with
zero human/tooling decision latency built in, not a production SLO. Lab
28's own split-brain demonstration is the direct warning this design
repeats: naively restarting an old, stopped primary after a promotion has
already happened produces real, observed data divergence (both nodes
independently believing they are primary, each accepting a write the
other will never see) - reintroducing a failed-over node safely requires
`pg_rewind` or a fresh base backup, never a plain restart, exactly as Lab
28's README states.

**Schema changes rolling out gradually across a multi-region fleet**:
expand/contract, Lab 29's exact sequence (add nullable column, deploy
compatible code, dual-write, batched-and-resumable backfill, switch
reads, drop the old column later) - necessary here specifically because
"gradual, multi-region rollout" means old and new application code
*will* run concurrently against the same schema for a real window of
time, which is precisely the scenario Lab 29's naive-migration
demonstration shows breaking (`ALTER TABLE ... RENAME COLUMN` against a
still-running old application version producing a real `SQLSTATE
42703`). `CREATE INDEX CONCURRENTLY` (Lab 29's own measured contrast: a
plain `CREATE INDEX` blocked an unrelated write for the index build's
full 1957ms duration versus a concurrent build never blocking a 3ms
unrelated write) is the default for any index added to a large,
actively-written table in this design.

**Large audit/activity tables staying queryable at billions of rows**:
range partitioning by time (Lab 35) plus keyset/cursor pagination for any
listing API over them (Lab 34), not `OFFSET`-based pagination and not an
unpartitioned table with only an index. Lab 35's own real numbers isolate
the honest partitioning-specific win: an indexed-but-unpartitioned
7-day-window query touched 46,806 buffers, versus 2,502 buffers against
the equivalent partitioned table (an 18.7x reduction attributable to
partition pruning specifically, not to indexing, which Lab 35 measured
and attributed separately). Lab 35 is equally honest about the
counter-example this design must not ignore: a query with no filter on
the partition key touched *more* total buffers on the partitioned table
than the flat one (68,225 vs 54,552) - partitioning only helps queries
that can be range-restricted by the partition key, and this design's
audit/activity access patterns need to be range-restrictable by time for
partitioning to pay off. Lab 34's own numbers are the direct argument
against `OFFSET`-based pagination on these tables at scale: naive
`OFFSET`/`LIMIT` slowed 1,688x from page 1 to a deep page (0.017ms to
28.702ms) over a 600,000-row table, while keyset pagination on the same
data stayed flat (0.011-0.017ms) at every depth tested, because a keyset
query seeks directly to a B-tree position instead of walking-and-
discarding every preceding row.

**General query-tuning discipline underlying all of the above**: measure,
inspect the plan, form a hypothesis, change one thing, measure again -
Lab 33's own discipline, and Lab 33's own numbers are the direct argument
against blind indexing at this scale: adding 4 indexes to support a
realistic reporting workload measured only an 11% throughput cost on
writes, an acceptable tradeoff *because it was measured*, not assumed;
Lab 33 also captured a case (a missing-index 3-table join) where wall-
clock time dropped 44% while total buffer touches actually went *up*
26%, real evidence that sequential and random I/O are not equivalent
costs and that "fewer buffers" alone is not a valid proxy for "faster."

### 5. Failure modes

- **A tenant's data leaks across tenant boundaries due to an application
  bug**: prevented by RLS (with `FORCE`) rather than merely caught by it
  after the fact - Lab 39's own measured `rowsBelongingToOtherTenants: 0`
  result for both real leak classes it reproduced.
- **A user reads their own just-written data from a stale regional
  replica**: prevented for read-after-write-classified operations by
  routing to the primary (or LSN-gating the replica read), per Lab 25/26 -
  never by hoping replication is "usually fast enough."
- **A regional primary fails outright**: `pg_promote()` promotion (Lab
  28), with an explicit runbook step against naively restarting the old
  primary (real documented split-brain risk).
- **A schema migration ships while old and new application code
  coexist across regions during a gradual rollout**: expand/contract
  (Lab 29) makes both versions correct simultaneously; a direct,
  non-backward-compatible change does not.
- **An audit table's growth degrades query latency over months**: caught
  by ongoing `EXPLAIN ANALYZE`-driven monitoring (Lab 33's discipline)
  and addressed structurally via partitioning + keyset pagination (Lab
  34/35) before it becomes an incident, not reactively once dashboards
  are already unusable.

### 6. Scale estimate

Billions of rows in audit/activity tables is squarely Lab 34/35's tested
range (Lab 34 tested 600,000 rows and demonstrated the *mechanism* - a
B-tree seek is O(log n) regardless of table size - that is what makes
keyset pagination's flat performance hold at far larger scale too, not
merely at the tested size). Connection fan-out from a large multi-region
application-server fleet is exactly the problem Lab 23's PgBouncer
numbers address (pooling, not scaling `max_connections` itself, is the
lever). Read-heavy regional traffic is handled by regional read-replica
fan-out (Lab 25), with cascading replicas (Lab 27) specifically for the
case where one region's own replica count grows large enough that a flat
topology would overload that region's primary's replication fan-out -
Lab 27's own real numbers show the primary's replication connection
count staying flat (exactly one `walreceiver` row in `pg_stat_replication`
regardless of how many replicas exist further down the chain) as the
direct benefit.

### 7. Observability

- Lab 38's three pillars, extended per-region: structured logs with
  correlation IDs that carry across region boundaries (a user's write in
  region A followed by a read wick they intended for the same session),
  Prometheus metrics including real DB-pool gauges per region (Lab 38's
  own `db_pool_waiting_clients` - a literal queue depth, not a metaphor),
  and `pg_stat_activity`/`pg_locks` inspection per region during
  incidents.
- Per-region `pg_wal_lsn_diff`-based replication-lag dashboards (Lab
  26's corrected metric, not `replay_lag`), with alerting thresholds tied
  to the read-after-write strategy's own assumptions (if actual lag
  regularly exceeds what the LSN-gated wait's timeout budget assumes,
  that is itself an incident).
- RLS-policy audit: which roles have `BYPASSRLS` or table ownership
  (Lab 39's `pg_roles`/ownership check), reviewed as part of any new role
  or migration-tooling change, not just at initial setup.
- Migration-rollout dashboards showing which application version is live
  in which region during an expand/contract rollout, so "is it safe to
  proceed to the contract phase" is answerable from data, not from
  assuming the rollout finished.

## Common wrong answer

**"Run one single global Postgres primary, and put a read replica in
every region purely for read latency."** This looks appealing because it
keeps "one source of truth" simple, but it fails the stated requirements
directly: every write, plus every read-after-write and transactional
read (which Lab 25 shows must route to the primary, not a replica -
Lab 25's own real captured `SQLSTATE 25006` rejection of a locking read
routed to a replica proves a transaction cannot be split across nodes),
now pays full cross-region round-trip latency for every user far from
wherever that single primary lives - the opposite of "low read latency
for users near each region," since it also degrades write and
transactional-read latency specifically for the majority of regions.
It also makes the single global primary a single global failure domain:
Lab 28's own promotion mechanism only makes sense with a nearby, in-
region replica to promote from quickly; promoting a distant replica
across regions during an incident adds exactly the cross-region latency
this design is trying to avoid, at the worst possible moment. The correct
shape assigns tenants (or accounts) to a home-region primary, with local
in-region replica fan-out for that region's own read traffic, and treats
genuine cross-region write requirements (rare, and usually product-level
decisions like "which region does this new customer's data live in") as
an explicit routing/assignment problem rather than the default
architecture.

## Interview questions

- Why does tenant isolation need to be a Postgres-enforced (RLS) property
  rather than an application-code convention, even on a team that trusts
  its own code review process?
- A support engineer needs a debugging view across all tenants. How does
  this design let that engineer query across tenants safely, given that
  RLS is meant to block exactly that by default?
- Explain, using Lab 26's own gotcha, why `pg_stat_replication.replay_lag`
  is not a safe metric to alert on for this design's staleness
  guarantees, and what to use instead.
- Why is `FORCE ROW LEVEL SECURITY` specifically necessary, given that
  RLS policies already exist on the table?
- At what point does "add another read replica" stop being the right
  answer to a regional read-latency problem, and what would you reach
  for instead?
