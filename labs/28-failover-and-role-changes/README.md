# Lab 28 - Failover and Role Changes

## Why this exists

Lab 24 built a real primary/standby pair and showed WAL shipping, replay,
and lag. Lab 25/26 built routing and consistency strategies on top of a
topology that is always assumed healthy. None of those labs ever asked the
question every on-call engineer eventually has to answer for real: **the
primary just died - now what?** Postgres's own physical replication has no
opinion about that. A standby will happily stay a standby forever, patiently
waiting for a primary that is never coming back, unless something outside
Postgres decides to promote it. This lab makes that decision, and its real
consequences, concrete: a genuine container failure, a genuine
`pg_promote()` call, a genuine measured window where the entire cluster
cannot accept a single write, and a genuine split-brain risk if the old
primary is ever brought back carelessly.

## Learning objectives

After this lab you should be able to:

- explain why Postgres has no built-in automatic failover, and what
  `pg_promote()` actually does (and does not do) on its own;
- promote a real physical standby to a real, independent, writable primary
  using the modern SQL-callable `pg_promote()` function (Postgres 12+),
  not the older trigger-file mechanism;
- measure, honestly, how long writes are unavailable across an entire
  cluster during an unplanned primary outage, from confirmed-down to
  first-successful-write-anywhere;
- distinguish a SQL-level write rejection (`SQLSTATE 25006`, the node is
  reachable and correctly refusing) from a connection-level failure
  (`ECONNREFUSED`, the node is simply gone) - and explain why an application
  experiences these two very differently;
- explain why a naively-restarted old primary is a real split-brain risk,
  not a hypothetical one, and what `pg_rewind` or a fresh base backup
  would actually be needed to fix it;
- articulate why real production failover requires a separate orchestration
  layer (Patroni, repmgr, pg_auto_failover, or a human) - this lab's own
  `pg_promote()` call is a stand-in for that layer's decision, not a
  replacement for it.

## Architecture

```text
BEFORE FAILOVER                        AFTER pg_promote()

┌────────────┐   physical WAL   ┌────────────┐        ┌────────────┐   (no longer
│  primary   │ ────streaming──▶ │  replica   │        │  primary   │    replicating
│ writable   │                  │ read-only  │        │  STOPPED   │    anywhere -
└─────┬──────┘                  └─────┬──────┘        │ (container)│    independent
      │ writes                        │ reads only    └────────────┘    node now)
      ▼                                ▼                                ┌────────────┐
 pgweb-primary                   pgweb-replica                          │  replica   │
 (browser UI)                    (browser UI)                           │  PROMOTED  │
                                                                         │  writable  │
                                                                         └─────┬──────┘
                                                                               ▼
                                                                         pgweb-replica
                                                                    (same URL, new role)
```

Domain: a fresh, independent `widgets` table (id/public_id/name/value/
updated_at) - the same "small standalone table, the lesson is the
mechanism" domain Lab 24/26 use, defined only in this lab's own schema, not
imported from either. This lab is about failover mechanics, not data
modeling.

Fully independent of Lab 24/25/26/27: own Compose project name
(`lab28-failover-and-role-changes`), own container names (`lab28-*`), own
network, own volumes, own ports, own database.

### Why `bitnami/postgresql` again, and what's new here

Same image Lab 24/26 use, for the same reason (see Lab 24's README
"Architecture" for the full rationale about environment-variable-driven
replication setup vs. hand-authored `pg_hba.conf`/`pg_basebackup`). This lab
needs one additional real capability: **`pg_promote()`**, a normal SQL
function any sufficiently-privileged connection can call against a standby
(Postgres 12+). It requires no special image support - bitnami's replica is
just a normal physical standby, and `pg_promote()` is core Postgres. What
this lab adds beyond Lab 24/26 is real **container lifecycle control**
(`docker compose stop primary` / `start primary`) driven from Node via
`src/lib/docker-control.ts`, since the failure this lab teaches cannot be
honestly demonstrated by mocking a function call - it has to be a real
container that a real client can no longer reach.

## Setup

```bash
pnpm install
cp labs/28-failover-and-role-changes/.env.example labs/28-failover-and-role-changes/.env
cd labs/28-failover-and-role-changes
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate    # applies ONLY to the primary
pnpm seed          # writes ONLY to the primary
```

Confirm the topology is actually replicating (not just "both containers are
up") before doing anything else:

```bash
docker exec -e PGPASSWORD=lab28 lab28-primary \
  psql -U postgres -d lab28 -c \
  "SELECT application_name, state, sync_state FROM pg_stat_replication;"
```

Real captured output from this lab's own validation run:

```text
 application_name |   state   | sync_state
-------------------+-----------+------------
 walreceiver      | streaming | async
(1 row)
```

Open PGweb for the primary at http://localhost:8428 and for the replica at
http://localhost:8528 - both returned HTTP 200 in this lab's own validation
run.

## Scenario

A `widgets` row can only ever be created or modified through
`PRIMARY_DATABASE_URL` - until the moment this lab deliberately kills the
primary and promotes the replica, at which point `REPLICA_DATABASE_URL`
becomes the new, independent primary connection. Nothing in this lab's
application code (there is none, deliberately - see "Fix it") decides that
transition automatically. A script (standing in for a human or real HA
tooling) does.

## Prediction

Before running anything, predict:

1. When the primary container is stopped, does the replica notice on its
   own and promote itself?
2. What is different about the ERROR a client sees when writing to a
   reachable-but-read-only replica (before promotion) versus writing to a
   container that has actually been stopped?
3. After `pg_promote()`, is there any real difference to a client between
   the promoted node and a primary that was always a primary?
4. If the old (now-stopped) primary container is simply restarted, does it
   know it should become a replica of the newly-promoted node?

## Exercise

1. Run the setup commands above.
2. Run each scenario script in order and read its structured log output:

   ```bash
   pnpm scenario:baseline
   pnpm scenario:failover
   pnpm scenario:split-brain   # optional, destructive - see "Break it"
   ```

3. After `scenario:split-brain`, reset the lab before doing anything else:

   ```bash
   pnpm db:reset
   pnpm db:migrate
   pnpm seed
   ```

## Observe

- **`pnpm scenario:baseline`** (`baseline-topology.ts`) confirms
  `pg_stat_replication` shows exactly one streaming replica,
  `pg_is_in_recovery()` is `false` on the primary and `true` on the
  replica, and a canary row written on the primary replicates.

- **`pnpm scenario:failover`** (`failover-and-promote.ts`) is the heart of
  this lab. Real captured run from this lab's own validation:

  ```text
  BEFORE PROMOTION: direct write against the replica
    ok: false, sqlState: "25006", message: "cannot execute INSERT in a read-only transaction"

  STOPPING THE PRIMARY CONTAINER (docker compose stop primary)
    stopDurationMs: 10239.13

  APPLICATION-LEVEL CONSEQUENCE: write aimed at "the primary" while it is down
    ok: false, connectionErrorCode: "ECONNREFUSED", durationMs: 1.83

  TRIGGERING FAILOVER: SELECT pg_promote(true, 60)
    promoted: true, durationMs: 110.81

  pg_is_in_recovery() on the (formerly standby) node, immediately after promotion
    inRecoveryAfter: false

  AFTER PROMOTION: the SAME kind of INSERT that was rejected with SQLSTATE 25006 above
    ok: true, retries: 0, durationMs: 8.39

  REAL MEASURED WRITE-UNAVAILABILITY GAP (primary confirmed stopped -> first successful write anywhere)
    gapMs: 124.51
  ```

  Two numbers here matter for very different reasons:

  - **`stopDurationMs: 10239.13`** is how long `docker compose stop primary`
    itself took - Docker sends `SIGTERM` and waits up to a grace period
    (10s by default) before `SIGKILL`. This is **graceful-shutdown time**,
    not representative of a real crash (a real crash is instant - the
    process is just gone, no graceful shutdown happens at all). This lab
    measures the unavailability window starting only AFTER the stop is
    confirmed, specifically so this number does not contaminate the
    interesting one.
  - **`gapMs: 124.51`** is the real number this lab is actually teaching:
    once the primary is confirmed gone, how long until ANY write succeeds
    anywhere in the cluster? Here it is almost entirely the `pg_promote()`
    call itself (`110.81ms` of the `124.51ms`). In this lab that gap is
    small because promotion is triggered immediately, by a script, with no
    human latency. In production, this same gap also has to include
    whatever time it takes a human or HA tool to *decide* a failover is
    warranted (to avoid promoting during a transient blip) - that decision
    latency, not the mechanical promotion itself, dominates real-world
    failover time. See "Production notes."

- **`pnpm scenario:split-brain`** (`split-brain-old-primary-returns.ts`,
  precondition: run `scenario:failover` first) real captured run:

  ```text
  SPLIT BRAIN, REAL AND OBSERVED: BOTH nodes now report pg_is_in_recovery() = false
    oldPrimaryInRecovery: false, promotedNodeInRecovery: false

  REAL DATA DIVERGENCE
    oldPrimarySees: ["written-to-OLD-primary-after-naive-restart"]
    promotedNodeSees: ["written-to-PROMOTED-node-independently"]
  ```

  Two real, independent, writable Postgres nodes, each with a write the
  other has never seen and never will on its own.

- **PGweb** (http://localhost:8428 primary, http://localhost:8528 replica) -
  both returned HTTP 200 throughout this lab's own validation run.

## Break it

The realistic failure in this lab is not a bug to fix - it is the actual
production event this lab exists to rehearse: **the primary is simply gone,
and nothing brings it back automatically.**

```bash
pnpm scenario:failover
```

Read every log line. In particular, notice that between "primary container
confirmed stopped" and "pg_promote() returned," **nothing in Postgres did
anything**. The standby kept faithfully waiting for WAL from a primary that
no longer existed. It would have waited forever. The only thing that moved
this forward was this script's explicit `SELECT pg_promote(true, 60)` call.

Then go one step further and reproduce the split-brain risk:

```bash
pnpm scenario:split-brain
```

This naively restarts the stopped primary container - exactly what an
under-informed operator might do to "get the old server back" - and proves
it does NOT know a promotion happened. It just starts, as the primary it
always was, and immediately accepts an independent write that the actually-
promoted node will never see. This state cannot be repaired by this lab
(see "What does not automatically happen" below) - reset before continuing:

```bash
pnpm db:reset
pnpm db:migrate
pnpm seed
```

## Fix it

There is no application-code "fix" inside this lab, and that absence is
itself the point. The only way to close (or shorten) the write-
unavailability gap is to have *something* watching the primary's health and
ready to call `pg_promote()` (or the equivalent in a real HA tool) the
moment a real failure is detected - faster and more reliably than a human
noticing an alert and typing a command. That is precisely the job of tools
like Patroni, repmgr, and pg_auto_failover, or a managed service's control
plane (RDS/Aurora/Cloud SQL failover). **Building one of those from scratch
is explicitly out of scope for this lab** (per this lab's own brief) -
implementing real leader election, split-brain fencing, and health-check
consensus correctly is a substantial distributed-systems project in its own
right, not a lab exercise. What this lab shows instead is exactly the
decision point such a tool would automate, and how large the stakes are
around getting that decision - and only that decision - right.

## Why the fix works

There is no fix in the naive/corrected sense this repository normally uses.
Promotion is a real, one-way role change and the correct engineering
response to a real primary failure - it is not something to "avoid" the way
a race condition is. What matters is *who decides to trigger it and how
fast*, which is exactly the part this lab deliberately leaves external.

See `docs/replication-reference.md` for a cross-lab quick-reference on
failover and the other replication labs.

## Tradeoffs

- **`pg_promote()` (SQL function) vs. the trigger-file mechanism**: older
  Postgres versions (and some tooling) promote a standby by creating a
  `trigger_file` / `promote_trigger_file` on disk that Postgres polls for.
  `pg_promote()` (12+) is strictly better for anything already holding a
  database connection: no filesystem access to the container is needed, the
  call's own return value tells you promotion completed, and `wait_seconds`
  gives you a real timeout instead of guessing how long to poll a file's
  absence.
- **Async replication (this lab's default, same as Lab 24) means the
  promoted node can be missing the primary's very last commits.** A
  transaction the primary told a client had committed may never have been
  shipped as WAL before the primary died - after promotion, that
  transaction simply does not exist anywhere. This is the real cost of
  async replication's speed: a synchronous replica would guarantee no
  committed transaction is ever lost this way, at the cost of every primary
  commit waiting on the replica's acknowledgment (not exercised in this
  lab - see Lab 24's own tradeoffs section for the same distinction).
- **Fast automatic promotion vs. false-positive risk**: the faster a system
  decides "the primary is dead, promote now," the shorter the
  unavailability window - but also the more likely it is to promote during
  a transient blip (a GC pause, a brief network hiccup) and create exactly
  the split-brain risk this lab's `scenario:split-brain` demonstrates, now
  with BOTH nodes still healthy and disagreeing about who is primary. Real
  HA tools spend most of their complexity budget on this tradeoff (health
  check quorums, fencing, STONITH), not on the promotion call itself, which
  is one line of SQL.
- **This lab's own measured gap (~125ms) is a best case, not a typical
  one.** It has zero human/tooling decision latency built in - the script
  calls `pg_promote()` immediately after confirming the container is down.
  Real incidents spend most of their unavailability window on detection and
  decision-making (alerting, paging, a human or a quorum-based health check
  agreeing the primary is really gone), not on the mechanical promotion.

## Production notes

1. **What guarantee does this mechanism give?** Once `pg_promote()` returns
   `true`, the target node is a genuine, independent, fully writable primary
   - not a special or degraded mode. It can be written to, backed up, and
   itself acquire new standbys exactly like any primary.
2. **What does it not guarantee?** That the promoted node has every
   transaction the old primary ever told a client it committed (async
   replication can lose the tail); that the promotion decision itself was
   correct (nothing here checks whether the primary was really down versus
   experiencing a transient network partition); or that the old primary,
   if it comes back, will behave safely.
3. **What failure mode remains?** Split-brain: if the old primary is ever
   restarted without first being rewound or rebuilt from a fresh base
   backup, it will resume accepting writes as an independent primary - this
   lab's `scenario:split-brain` reproduces this directly, not as a
   thought experiment.
4. **How does contention affect it?** Not directly - promotion is a one-time
   role change, not a per-transaction operation. What contention DOES
   affect is how much WAL the old primary generated right before dying
   (higher write throughput means a bigger potential async-replication gap
   lost at failover).
5. **What changes at larger scale?** With more standbys, "which one gets
   promoted" becomes its own decision (the most caught-up one, ideally,
   which real HA tools track via LSN comparison) - this lab's two-node
   topology has no such choice to make. At larger scale, cascading replicas
   (Lab 27) also complicate this: a promoted node's own downstream replicas
   need to be repointed at it, which Postgres also does not do
   automatically.
6. **What metrics would be monitored?** Whether `pg_stat_replication` on the
   primary continues showing the expected connected replica(s) at all (zero
   rows is itself an incident, as Lab 24 notes); replica replay lag, so a
   promotion decision can account for how much data a given standby might
   be missing; and, after any real promotion, whether the old primary's
   container/host has actually been fenced off from ever accepting a write
   again until deliberately rebuilt.
7. **What simpler alternative could be used?** None for actual failover
   itself - some node has to become newly writable, and that is what
   promotion is. The simpler alternative that DOES exist is in how the
   decision to promote gets made: a fully manual, human-in-the-loop runbook
   (slower, but immune to false-positive automated promotions) versus a
   real HA tool's automated quorum-based detection (faster, but only as
   safe as its fencing logic).
8. **When should you avoid this technique?** Never avoid promotion itself
   during a genuine primary failure - the alternative is an indefinitely
   unwritable database. What should be avoided is triggering it casually,
   without confidence the primary is actually gone (versus temporarily
   unreachable), and restarting an old primary without first rewinding or
   rebuilding it - see "What does not automatically happen" below.

## What does not automatically happen

This is the single most important thing to take from this lab, stated
explicitly per this lab's own brief:

- **Postgres does not detect primary failure.** No background process on
  the standby, and nothing on the primary, decides "the other node is
  gone." A standby with no primary to stream from just keeps waiting,
  indefinitely, showing nothing unusual in its own logs beyond
  "could not connect to the primary" retries.
- **Postgres does not decide to promote a standby on its own.**
  `pg_promote()` must be called - by a human running a command, or by real
  orchestration tooling (Patroni, repmgr, pg_auto_failover) that itself
  implements health checking, quorum/consensus on "is the primary really
  down," and fencing to prevent the split-brain this lab's
  `scenario:split-brain` reproduces. This lab's own `pg_promote()` call in
  `failover-and-promote.ts` is a direct, explicit stand-in for whatever that
  layer would do - it is not a simplification of something Postgres would
  otherwise do by itself; Postgres provides none of that decision logic at
  all.
- **Postgres does not repoint applications at the new primary.** After
  promotion, any application connection string still pointed at the old
  `PRIMARY_DATABASE_URL` stays broken until an operator (or, in production,
  a proxy/DNS/service-discovery layer) updates it to point at the
  now-promoted node. This lab does not build that routing layer - Lab 25
  is where this repository builds primary/replica connection routing, and
  even that lab's router has no notion of "the primary changed identity."
- **Postgres does not make it safe to just restart the old primary.** As
  `scenario:split-brain` shows directly, a naively-restarted old primary
  resumes as an independent, writable primary with its own diverged WAL
  history. Making it safe again requires either `pg_rewind` (finds the last
  common checkpoint between the two diverged timelines and rewinds the old
  primary's data directory back to it, discarding its diverged writes, so
  it can then stream forward from the new primary as a real standby) or a
  fresh base backup from the new primary (wipe the old primary's data
  directory entirely and re-bootstrap it, the same process this lab's own
  replica went through the first time). This lab does not implement either
  - per its own scope, that is exactly the class of operation real HA
  tooling automates, and a from-scratch reimplementation here would teach
  the wrong lesson (that a home-grown failover script is a substitute for
  battle-tested HA tooling, when it is closer to a demonstration of why
  that tooling exists).

## Interview questions

1. Why can't Postgres detect and promote on its own, architecturally - what
   would it need to have in order to do that safely?
2. What is the practical difference between the `SQLSTATE 25006` this lab's
   replica returns before promotion and the `ECONNREFUSED` it returns to a
   write aimed at the stopped primary - why does an application need to
   handle these differently?
3. `pg_promote()`'s `wait_seconds` parameter defaults to 60. What would you
   set it to in production, and what happens if promotion doesn't complete
   within that window?
4. Why is a naively-restarted old primary a MORE dangerous state than a
   dead one? (Hint: compare "no writable primary exists" to "two primaries
   both think they're in charge.")
5. What would `pg_rewind` actually need to exist for it to work (what has
   to be true about the old primary's data directory)?
6. If this lab's replica had two downstream cascading replicas (Lab 27),
   what would `pg_promote()` NOT automatically fix about them?
7. Why does real HA tooling spend most of its complexity on failure
   *detection* and *fencing* rather than on the promotion call itself?
8. This lab measured a ~125ms write-unavailability gap. Why is that number
   almost meaningless as a production SLO estimate on its own?

## Further experiments

- Modify `failover-and-promote.ts` to add an artificial delay between
  "primary confirmed stopped" and the `pg_promote()` call (simulating human
  decision latency) and watch `gapMs` grow to match it directly.
- Lower `pg_promote()`'s `wait_seconds` argument to something unrealistically
  small (e.g. `1`) and see it return `promoted: false` instead of throwing -
  what should a caller do in that case?
- After `scenario:split-brain`, instead of `pnpm db:reset`, try manually
  reasoning through (without executing) what a `pg_rewind` invocation
  against the old primary would need: a common WAL history checkpoint, the
  new primary reachable over the network, and `wal_log_hints` or checksums
  enabled - check whether this lab's `docker-compose.yml` would need to
  change to support that at all.
- Add a third node as a second standby of the ORIGINAL primary, fail over,
  and observe that the second standby is now silently orphaned - it never
  automatically starts following the newly-promoted node.
