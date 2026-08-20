# Lab 27 - Cascading Replicas

## Why this exists

Labs 24-26 all used exactly two Postgres nodes: one primary, one standby.
Real deployments frequently need more read capacity than a single primary
can comfortably fan out to directly - the fix is not "add more direct
replicas of the primary" (which keeps adding load and connections to the
primary itself) but **cascading replication**: a standby can itself act as
the upstream source for another standby, using the exact same physical WAL
streaming mechanism Lab 24 taught, just chained. This lab builds a genuine
three-node chain - `primary -> replica-1 -> replica-2` - and proves, with
real captured evidence, both the benefit (the primary's fan-out never grows
past one connection) and the cost (an extra hop of lag, and a new single
point of failure in the middle tier).

## Learning objectives

After this lab you should be able to:

- explain what cascading replication is and why `pg_stat_replication` is
  always a "who is downstream of the node I just queried" view, never a
  global topology view;
- confirm a cascading topology is actually wired correctly by querying
  `pg_stat_replication` at every tier, not by trusting `docker-compose.yml`;
- explain why cascading reduces primary fan-out load, and quantify the
  tradeoff: additional propagation lag through the extra hop;
- reproduce the real, non-obvious behavior of `recovery_min_apply_delay`
  across a cascade (it does NOT stack additively when applied to multiple
  tiers, because it is anchored to the WAL record's original commit
  timestamp, not to each hop's own receipt time);
- reproduce the operational consequence of a middle-tier replica failing:
  every replica below it stops receiving new data entirely, with no
  alternate path, until the middle tier itself recovers.

## Architecture

```text
┌──────────┐   physical WAL   ┌───────────┐   physical WAL   ┌───────────┐
│ primary  │ ────streaming──▶ │ replica-1 │ ────streaming──▶ │ replica-2 │
│(bitnami/ │                  │ (bitnami/ │                  │ (bitnami/ │
│postgresql)│ ◀──ack (async)– │postgresql)│ ◀──ack (async)–  │postgresql)│
└────┬─────┘                  └────┬──────┘                  └────┬──────┘
     │ writes only                 │ standby of primary            │ reads only
     ▼                             │ AND upstream of replica-2      ▼
pgweb-primary                      ▼                          pgweb-replica-2
(browser UI)                 pgweb-replica-1
                              (browser UI)
```

replica-2's `POSTGRESQL_MASTER_HOST` points at **replica-1**, not at the
primary - replica-2 never opens a connection to the primary at all. The
primary's own `pg_stat_replication` therefore only ever shows **one**
connected downstream node (replica-1), regardless of how many leaf replicas
eventually consume the data further down the chain. replica-1 simultaneously
holds two roles on the same Postgres process: it is a **standby** relative
to the primary (`pg_is_in_recovery() = true`) and an **upstream** relative
to replica-2 (it appears in replica-1's own `pg_stat_replication`).

Domain: a single, deliberately minimal `widgets` table (`id` bigint
identity, `public_id` uuid, `name`, `value`, `updated_at`) - not one of
SPEC.md section 8.2's five named domains. Same "small standalone table, the
lesson is the mechanism" rationale as Lab 06's `counters`/Lab 24's
`widgets`/Lab 26's `user_profiles`: this lab's subject is the cascading
topology, propagation-lag, and failure-mode mechanics, not data modeling.

### A real bitnami/postgresql limitation this lab had to work around

`bitnami/postgresql`'s entrypoint only appends a `host replication ...`
entry to `pg_hba.conf` when `POSTGRESQL_REPLICATION_MODE=master` (see
`postgresql_add_replication_to_pghba` in `/opt/bitnami/scripts/libpostgresql.sh`,
called only from the image's "master" branches). A node running in `slave`
mode - replica-1 in this lab - never gets that entry, because the image was
written assuming a slave is always a leaf. Without a fix, replica-2's
initial `pg_basebackup` against replica-1 fails immediately with a real
captured error:

```text
pg_basebackup: error: connection to server at "replica-1" (172.24.0.3), port 5432 failed: FATAL:  no pg_hba.conf entry for replication connection from host "172.24.0.6", user "repl_user", no encryption
```

The fix, applied in `docker-compose.yml` and `config/replica1-pg_hba.conf`:
replica-1 mounts a custom `pg_hba.conf` (identical to what bitnami generates
for a **master** node - i.e. it also permits incoming replication
connections) at `/bitnami/postgresql/conf/pg_hba.conf`, and sets
`POSTGRESQL_USE_CUSTOM_PGHBA_INITIALIZATION=yes` so the entrypoint treats it
as an external, do-not-regenerate file. This is a real, documented bitnami
extension point (`POSTGRESQL_MOUNTED_CONF_DIR`), not a hack around the
image - see `config/replica1-pg_hba.conf`'s own comment for the full trace
through the entrypoint script.

## Setup

```bash
pnpm install
cp labs/27-cascading-replicas/.env.example labs/27-cascading-replicas/.env
cd labs/27-cascading-replicas
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate    # applies ONLY to the primary
pnpm seed          # writes ONLY to the primary
```

Open PGweb for the primary at http://localhost:8427, replica-1 at
http://localhost:8527, and replica-2 at http://localhost:8627 - all three
should show the same `widgets` rows a moment after seeding, even though only
the primary connection string was ever used to write them.

Confirm the topology is actually cascading (not just "all three containers
are up") before doing anything else - query `pg_stat_replication` at THREE
different tiers:

```bash
docker exec -e PGPASSWORD=lab27 lab27-primary \
  psql -U postgres -d lab27 -c \
  "SELECT application_name, state, sync_state FROM pg_stat_replication;"

docker exec -e PGPASSWORD=lab27 lab27-replica-1 \
  psql -U postgres -d lab27 -c \
  "SELECT application_name, state, sync_state FROM pg_stat_replication;"

docker exec -e PGPASSWORD=lab27 lab27-replica-2 \
  psql -U postgres -d lab27 -c \
  "SELECT application_name, state, sync_state FROM pg_stat_replication;"
```

Real captured output from this lab's own validation run:

```text
-- on the PRIMARY: exactly one connected downstream node (replica-1)
 application_name |   state   | sync_state
------------------+-----------+------------
 walreceiver      | streaming | async
(1 row)

-- on REPLICA-1: exactly one connected downstream node (replica-2)
 application_name |   state   | sync_state
------------------+-----------+------------
 walreceiver      | streaming | async
(1 row)

-- on REPLICA-2: zero rows - it is a leaf, nothing streams from it
(0 rows)
```

## Scenario

A `widgets` row can only ever be created or modified through
`PRIMARY_DATABASE_URL`. Neither replica is ever written to directly -
replica-1 receives rows via WAL replay of the primary, and replica-2
receives them via WAL replay of **replica-1's own re-forwarded stream**,
never from the primary.

## Prediction

Before running anything, predict:

1. If you query `pg_stat_replication` on the primary, will it ever show two
   rows once replica-2 exists? Why or why not?
2. If a write commits on the primary, will it always reach replica-2 no
   later than it reaches replica-1?
3. If you set a `recovery_min_apply_delay` of 150ms on BOTH replica-1 and
   replica-2, will the total primary-to-replica-2 lag be roughly 300ms
   (150+150) or roughly 150ms? Why?
4. If replica-1 is stopped, does replica-2 keep receiving writes made to the
   primary in the meantime? What has to happen for replica-2 to catch up
   once replica-1 comes back?

## Exercise

1. Run the setup commands above.
2. Run each scenario script in order and read its structured log output:

   ```bash
   pnpm scenario:topology
   pnpm scenario:cascading-lag
   pnpm scenario:upstream-failure
   ```

3. Open all three PGweb instances side by side and manually insert a row via
   `psql "$PRIMARY_DATABASE_URL"` while watching replica-1's and replica-2's
   PGweb table views - refresh them and watch the row appear on replica-1
   first, then on replica-2.

## Observe

- **`pnpm scenario:topology`** (`topology-and-fanout.ts`) queries
  `pg_stat_replication` on all three nodes. Real captured run:

  ```text
  pg_stat_replication ON THE PRIMARY: connectedDownstream: 1
    [{ application_name: "walreceiver", state: "streaming", sync_state: "async" }]
  pg_stat_replication ON REPLICA-1:    connectedDownstream: 1
    [{ application_name: "walreceiver", state: "streaming", sync_state: "async" }]
  pg_stat_replication ON REPLICA-2:    connectedDownstream: 0
    []
  cascading topology confirmed: primary -> replica-1 -> replica-2, primary fan-out stays at exactly 1 connection
  ```

  This is the core architectural point: no matter how many leaf replicas
  eventually exist below replica-1 (in this lab, one; in a real deployment,
  potentially many chained further down), **the primary's own connection
  count never grows** - it always serves exactly one downstream connection.

- **`pnpm scenario:cascading-lag`** (`cascading-lag.ts`) measures real
  propagation lag in three phases. Real captured run:

  **Phase 1 - baseline, no artificial delay** (10 writes):

  ```text
  avgHop1LagMs: 1.91   avgTotalLagMs: 2.41   avgAdditionalHopLagMs: 0.49
  minHop1LagMs: 0.41   maxTotalLagMs: 7.44
  ```

  On a local Docker Desktop loopback network with tiny WAL volume, both hops
  are genuinely fast - the additional hop still costs real, positive time
  (the total is never smaller than hop 1 alone), but sub-millisecond numbers
  are easy to dismiss as noise.

  **Phase 2 - a real `recovery_min_apply_delay` of 150ms on BOTH replica-1
  AND replica-2** (8 writes):

  ```text
  avgHop1LagMs: 154.53   avgTotalLagMs: 155.90   avgAdditionalHopLagMs: 1.37
  minHop1LagMs: 151.26   maxTotalLagMs: 159.02
  ```

  A genuinely surprising, real result: configuring 150ms on EACH tier did
  **not** produce ~300ms total lag - it produced ~155ms, barely more than
  hop 1 alone. See "Break it" below for why.

  **Phase 3 - delay ONLY replica-2 (150ms), leave replica-1 undelayed**
  (8 writes):

  ```text
  avgHop1LagMs: 4.13   avgTotalLagMs: 154.38   avgAdditionalHopLagMs: 150.25
  minHop1LagMs: 0.55   maxTotalLagMs: 159.15
  ```

  This isolates the extra hop's cost cleanly: hop 1 stays fast (real network
  + replay time only), and the additional hop lag lands almost exactly on
  the configured 150ms - the total primary-to-replica-2 lag is now clearly
  and attributably larger than the primary-to-replica-1 lag alone.

- **`pnpm scenario:upstream-failure`** (`upstream-failure.ts`) genuinely
  stops the `lab27-replica-1` Docker container (a real `docker stop`, not a
  simulated failure). Real captured run:

  ```text
  sanity check passed: cascade is healthy before the outage
  stopping replica-1 - a genuine container stop, not simulated
  pg_stat_replication on the PRIMARY during the outage: connectedDownstream: 0
  writing to the primary WHILE replica-1 is down
  row committed on primary during the outage
  confirmed: replica-2 has NOT received the row - replica-1 is its only path to the primary, and that path is down
    visibleOnReplica2: false
  bringing replica-1 back up
  replica-1 is healthy again
  replica-1 has caught up and now has the during-outage row
  replica-2 has automatically caught up - no manual intervention was needed beyond restarting replica-1
  cascade topology fully restored: primaryConnectedDownstream: 1, replica1ConnectedDownstream: 1
  ```

- **PGweb** (http://localhost:8427 primary, http://localhost:8527
  replica-1, http://localhost:8627 replica-2): browse `widgets` on all three
  and confirm they agree once things settle.

## Break it

**The middle-tier single point of failure.** `pnpm scenario:upstream-failure`
reproduces the real operational consequence CLAUDE.md calls out directly:
stop replica-1, and replica-2 - which has no connection to the primary at
all - stops receiving new data completely. This is not degraded service, it
is a hard stop: a write made to the primary while replica-1 is down is
genuinely, provably absent from replica-2 even after a real 3-second
observation window. The moment replica-1 comes back and resumes streaming
from the primary, it automatically re-forwards its backlog to replica-2,
which catches up with **no manual intervention** - but until that moment,
every node below the failed tier is stuck, no matter how healthy those
nodes' own processes are.

Reproduce it directly, live:

```bash
docker stop lab27-replica-1
psql "$PRIMARY_DATABASE_URL" -c "INSERT INTO widgets (name, value) VALUES ('written-during-outage', 1);"
psql "$REPLICA2_DATABASE_URL" -c "SELECT * FROM widgets WHERE name = 'written-during-outage';"
# 0 rows - genuinely absent, not stale
docker start lab27-replica-1
# wait a few seconds, then re-run the SELECT on replica-2 - the row is now there
```

**The `recovery_min_apply_delay`-does-not-stack surprise.** Phase 2 of
`pnpm scenario:cascading-lag` configures a 150ms delay on BOTH replica-1
and replica-2, expecting (naively) roughly 300ms of total lag. The real
captured result was ~155ms - barely more than one hop's delay alone. This
is because `recovery_min_apply_delay` is calculated **relative to the WAL
record's original commit timestamp on the primary**, not relative to when
each downstream node itself received that record (see the Postgres docs for
`recovery_min_apply_delay`). Both replica-1 and replica-2 independently
compute the same target - "don't apply this record until `commit_time +
150ms`" - and by the time replica-2 has even received the record (which
requires waiting for replica-1 to replay AND re-forward it, itself already
~150ms after commit), replica-2's own 150ms target has nearly already
elapsed. The two configured delays do not add together. Phase 3 shows the
clean way to make the extra hop's cost observable instead: delay only the
tier whose additional cost you want to measure.

## Fix it

There is no code-level "fix" for the middle-tier single point of failure in
the naive/solution sense used elsewhere in this repository - cascading
replication's tradeoff is structural, not a bug. The real "fix," if the
outage window matters more than the fan-out savings, is architectural:
either accept the window (cascading is still strictly better than the
alternative of NOT reducing primary fan-out at all, for workloads where a
brief staleness window on the leaf tier is acceptable), or have replica-2
connect directly to the primary instead (reintroducing primary fan-out
load, the very cost cascading exists to avoid), or run TWO middle-tier
replicas in parallel as redundant upstreams for replica-2 (not modeled in
this lab - Postgres does not support automatic failover between multiple
upstream sources for a single cascading standby without an external tool
like `repmgr` or `patroni` managing `primary_conninfo` and triggering a
reconnect).

## Why the fix works

Postgres's physical streaming replication treats a "standby with a
downstream connection" no differently from a "primary with a downstream
connection" - the WAL sender process on replica-1 does not know or care
whether it is itself in recovery. This is WHY cascading works at all: it is
not a special mode, it is the same mechanism applied one level deeper. The
`docker stop`/`docker start` cycle in `upstream-failure.ts` relies on
exactly this: replica-1's own recovery state (tracking the primary) and its
role as an upstream for replica-2 are independent concerns, so restarting
it resumes both automatically, in the order Postgres's own WAL positions
dictate - no application code coordinates any of this.

See `docs/replication-reference.md` for a cross-lab quick-reference on
cascading replicas and the other replication labs.

## Tradeoffs

- **Reduced primary fan-out vs. an added single point of failure**: the
  entire point of this lab. Every replica added below replica-1 makes the
  primary fan-out savings bigger, but also makes replica-1's own uptime
  matter to more downstream consumers.
- **Additional propagation lag**: even under ideal conditions (Phase 1,
  no artificial delay), the additional hop's lag is real and strictly
  positive - never negative, never zero on average. On a real
  network-separated topology (not this lab's local loopback), expect this
  to be measurably larger than the ~0.5ms observed here.
- **`recovery_min_apply_delay` for teaching**: real, not a mock, but its
  commit-timestamp anchoring means it does not naively compose across
  cascade hops the way a human might expect - a real, worth-internalizing
  nuance about how it actually works, not just "delay = delay."
- **`bitnami/postgresql`'s custom `pg_hba.conf` mount**: this lab required
  working around a real gap in the base image (see "Architecture") -
  production deployments using cascading replication with any similar image
  need the same kind of check: does the middle tier's own `pg_hba.conf`
  actually permit an incoming replication connection from a THIRD node?

## Production notes

1. **What guarantee does this mechanism provide?** Every committed write on
   the primary is eventually replayed on every leaf replica, in the same
   order it was committed on the primary, regardless of how many cascade
   hops separate them - and the primary's own connection count is bounded
   by its DIRECT children only, not by the total replica count.
2. **What does it not guarantee?** Any bound on how quickly a leaf replica
   catches up (each hop adds its own, real, independent lag), nor
   availability of leaf replicas' data during a middle-tier outage - a leaf
   replica can be fully healthy as a Postgres process and still be
   completely stale relative to the primary.
3. **What breaks under process crash?** If a middle-tier replica crashes,
   every node cascading from it stops receiving new WAL immediately, with
   no automatic rerouting to another upstream - this lab's own
   `upstream-failure.ts` demonstrates exactly this. Production systems that
   need automatic failover between upstream sources for a cascading standby
   need an external tool (`repmgr`, `patroni`) to detect the outage and
   rewrite `primary_conninfo`.
4. **How does contention affect it?** Higher write throughput at the
   primary means more WAL every downstream node must receive and replay -
   in a cascade, the SLOWEST node in the chain determines how far behind
   the leaf tier can fall, since each hop can only forward what it has
   itself already replayed.
5. **What changes at larger scale?** Cascading becomes proportionally more
   valuable as the number of leaf replicas grows - fanning 50 replicas out
   directly from one primary vs. fanning 10 groups of 5 through 10
   middle-tier replicas is the entire argument for this pattern in the
   first place.
6. **What metrics would be monitored?** `pg_stat_replication` at EVERY
   tier (not just the primary) - a leaf replica's staleness cannot be
   inferred from the primary's own replication view once cascading is in
   play, since the primary genuinely cannot see past its direct children.
7. **When should this approach be avoided?** When the operational cost of
   monitoring and alerting on an extra tier of failure modes outweighs the
   fan-out savings - for a small number of replicas, replicating all of them
   directly from the primary is simpler to reason about and has one fewer
   failure mode per replica.

## Interview questions

1. Why does `pg_stat_replication` never show a global view of the whole
   replication topology, no matter which node you query it on?
2. What is the actual benefit of cascading replication - is it lag, primary
   fan-out, both, or neither?
3. Why doesn't a 150ms `recovery_min_apply_delay` on two chained replicas
   produce ~300ms of total lag?
4. If replica-1 crashes, what specifically happens to replica-2, and what
   has to happen for replica-2 to recover?
5. What would you need to add to this topology to survive a middle-tier
   replica failure without a stale-data window on the leaf tier?
6. Why is a standby's role as "upstream for another standby" not a special
   Postgres replication mode?

## Further experiments

- Add a fourth node, `replica-3`, with `POSTGRESQL_MASTER_HOST: replica-2`
  - confirm `pg_stat_replication` on replica-2 now shows one row, and the
    primary's still shows exactly one.
- Compare `docker stop lab27-replica-1` / `docker start lab27-replica-1`
  (data volume preserved, replica-1 reconnects and catches up from where it
  left off) against a full `docker compose down -v && docker compose up -d`
  (every node's data volume is destroyed, so replica-2 must re-bootstrap its
  ENTIRE base backup from replica-1 from scratch, which itself must first
  re-bootstrap from the primary) - measure how much longer the second path
  takes.
- Increase `REPLICA1_DELAY_MS`/`REPLICA2_DELAY_MS`/`ISOLATED_HOP_DELAY_MS`
  in `src/scenarios/cascading-lag.ts` and confirm Phase 3's
  `avgAdditionalHopLagMs` tracks the configured delay closely while Phase
  2's stays surprisingly small.
- Try `POSTGRESQL_SYNCHRONOUS_REPLICATION_MODE`-style synchronous
  replication on the primary -> replica-1 hop only, and re-measure Phase 1's
  baseline lag - does making that hop synchronous change replica-2's lag at
  all, given replica-2 only ever talks to replica-1?
