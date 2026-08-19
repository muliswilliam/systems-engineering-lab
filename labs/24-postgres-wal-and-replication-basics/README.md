# Lab 24 - WAL and Replication Basics

## Why this exists

Every earlier lab in this repository has run against exactly one PostgreSQL
node. Real production systems very rarely do: a single primary accepts
writes, and one or more physical standbys stream its write-ahead log (WAL)
and replay it to stay (nearly) current, so reads can be spread across
replicas and a standby can eventually be promoted if the primary fails.
Before any of that is useful, you need to actually see WAL shipping and
replay happen with real bytes and real LSNs, see a replica genuinely refuse
a write, and measure real (not imagined) replication lag. That is the whole
scope of this lab - Lab 25 builds read/write routing on top of it, Lab 26
builds read-after-write consistency strategies on top of that, and Lab 27+
extend the topology further.

## Learning objectives

After this lab you should be able to:

- explain what the WAL is and why physical streaming replication ships raw
  WAL records rather than replaying SQL statements on the replica;
- read and compare real LSN (log sequence number) values across a primary
  and a standby;
- stand up a genuine two-node primary/standby Postgres topology in Docker
  Compose and confirm the standby is actually connected via
  `pg_stat_replication`, not just "up";
- measure real replication lag between a commit on the primary and that
  row becoming visible on the replica;
- explain why a physical standby rejects writes at the Postgres level, and
  reproduce the exact rejection;
- recognize "the app wrote to the read replica by mistake" as a real,
  common production incident class, not a hypothetical.

## Architecture

```text
┌────────────┐   physical WAL    ┌────────────┐
│  primary   │ ─────streaming──▶ │  replica   │
│ (bitnami/  │                   │ (bitnami/  │
│ postgresql)│ ◀──ack (async)──  │ postgresql)│
└─────┬──────┘                   └─────┬──────┘
      │ writes only                    │ reads only (Postgres-enforced)
      ▼                                ▼
 pgweb-primary                    pgweb-replica
 (browser UI)                     (browser UI)
```

Domain: a single, deliberately minimal `widgets` table (`id` bigint
identity, `public_id` uuid, `name`, `value`, `updated_at`) - not one of
SPEC.md section 8.2's five named domains. This lab is about replication
mechanics, not data modeling, so a rich relational schema would only add
noise around the WAL/LSN/lag mechanics being taught (same "small standalone
table, the lesson is the mechanism" rationale as Lab 06's `counters`/Lab
11's `documents`/Lab 19's `notifications`).

### Why `bitnami/postgresql` instead of `postgres:16-alpine`

Every other lab in this repository uses `postgres:16-alpine`, and
CLAUDE.md's Docker Compose conventions assume that image. This lab
deliberately deviates, on **both** nodes, for one reason: the subject of
this lab **is** physical streaming replication setup itself. Getting two
plain `postgres` containers correctly replicating requires hand-authoring
`pg_hba.conf` entries for the replication user, editing `postgresql.conf`
for `wal_level`/`max_wal_senders`/`max_replication_slots`, running
`pg_basebackup` from the replica against the primary before Postgres will
even start there, and sequencing all of that correctly in Compose
`entrypoint`/`command` overrides. None of that teaches replication - it's
just YAML and shell scripting standing between you and the concept.

`bitnami/postgresql` drives the entire setup from environment variables:

- `POSTGRESQL_REPLICATION_MODE=master` (primary) or `slave` (replica);
- `POSTGRESQL_REPLICATION_USER` / `POSTGRESQL_REPLICATION_PASSWORD` - a
  dedicated role with the `REPLICATION` privilege, used only for the
  streaming connection (never for application traffic - see "Why the fix
  works");
- `POSTGRESQL_MASTER_HOST` / `POSTGRESQL_MASTER_PORT_NUMBER` (replica only)
  - where to find the primary for the initial base backup and the ongoing
    streaming connection;
- `POSTGRESQL_PASSWORD` - the `postgres` **superuser** password. It must be
  identical on both nodes: the replica authenticates against the primary
  using it during its initial `pg_basebackup`-equivalent bootstrap, and the
  replica's own data directory is then entirely replaced by a copy of the
  primary's, so this is "how do I reach and copy from the primary," not "what
  password does the replica's own database get." (If you set
  `POSTGRESQL_USERNAME` to something other than `postgres`, bitnami exposes
  a separate `POSTGRESQL_POSTGRES_PASSWORD` for the actual superuser - this
  lab leaves `POSTGRESQL_USERNAME` unset/default so `POSTGRESQL_PASSWORD`
  directly sets the superuser password.)
- `POSTGRESQL_ENABLE_TLS=no` - set explicitly (even though it is also the
  default) because TLS between the app and either node, and between the two
  nodes, is out of scope for this lab.
- `ALLOW_EMPTY_PASSWORD` is deliberately **not** set here - bitnami refuses
  to start without either a real password or that flag, which is the
  correct default; only ever set `ALLOW_EMPTY_PASSWORD=yes` in a fully
  disposable local scratch container, never anywhere persistent.

One real deviation worth calling out: as of 2025, Docker Hub only serves
the `latest` tag for `bitnami/postgresql` for free - version-pinned tags
(e.g. `16`, `16.6.0-debian-...`) now require a paid "Bitnami Secure Images"
subscription. `docker-compose.yml` therefore uses
`bitnami/postgresql:latest`, which at the time of writing resolves to
**PostgreSQL 18.6** - newer than the `postgres:16-alpine` every other lab in
this repository pins. That version difference does not matter for what
this lab teaches (WAL/LSN/streaming replication mechanics have been stable
across these major versions); it does mean this lab does not attempt to pin
an exact Postgres version the way Lab 01+ do.

## Setup

```bash
pnpm install
cp labs/24-postgres-wal-and-replication-basics/.env.example labs/24-postgres-wal-and-replication-basics/.env
cd labs/24-postgres-wal-and-replication-basics
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate    # applies ONLY to the primary
pnpm seed          # writes ONLY to the primary
```

Open PGweb for the primary at http://localhost:8424 and for the replica at
http://localhost:8524 - both should show the same `widgets` rows a moment
after seeding, even though only the primary connection string was ever
used to write them.

Confirm the topology is actually replicating (not just "both containers are
up") before doing anything else:

```bash
docker exec -e PGPASSWORD=lab24 lab24-primary \
  psql -U postgres -d lab24 -c \
  "SELECT application_name, state, sync_state FROM pg_stat_replication;"
```

Real captured output from this lab's own validation run:

```text
 application_name |   state   | sync_state
-------------------+-----------+------------
 walreceiver      | streaming | async
(1 row)
```

If that query returns zero rows, the replica is not connected and nothing
else in this lab will behave as documented - see "Break it" in
`playground/notes.md` for how to inspect why.

## Scenario

A `widgets` row can only ever be created or modified through
`PRIMARY_DATABASE_URL`. `REPLICA_DATABASE_URL` exists to READ that same
data from a second, independent Postgres node that is kept current purely
by replaying the primary's WAL - never by running its own copy of the
migration or the seed script.

## Prediction

Before running anything, predict:

1. If you insert a row on the primary and immediately (same millisecond)
   query the replica for it by primary key, will it always be there?
2. What SQLSTATE code (not just a message) does Postgres return when you
   attempt an `INSERT` against a standby connection?
3. Does `pg_current_wal_lsn()` return a bigger or smaller value after a
   batch of writes than before, and does the replica's own
   `pg_last_wal_replay_lsn()` ever get AHEAD of what the primary has sent?

## Exercise

1. Run the setup commands above.
2. Run each scenario script in order and read its structured log output:

   ```bash
   pnpm scenario:lag
   pnpm scenario:replica-rejects-writes
   pnpm scenario:wal-lsn
   pnpm scenario:artificial-lag
   ```

3. Open PGweb for both nodes side by side and manually insert a row via
   `psql "$PRIMARY_DATABASE_URL"` while watching the replica's PGweb table
   view - refresh it and watch the row appear.

## Observe

- **`pnpm scenario:lag`** (`write-to-primary-observe-replica.ts`) inserts 20
  rows on the primary one at a time and polls the replica for each until it
  appears, reporting min/max/avg lag. Real captured run on this lab's own
  Docker Desktop / loopback setup:

  ```text
  samples: 20
  minLagMs: 0.40
  maxLagMs: 7.56
  avgLagMs: 2.51
  ```

  This is genuinely fast because both nodes share one machine's loopback
  network and there is almost no WAL volume - do not expect these numbers
  on a real network-separated primary/replica pair; see "Production notes."

- **`pnpm scenario:replica-rejects-writes`** confirms `pg_is_in_recovery()`
  is `true` on the replica, then attempts a direct `INSERT` against it.
  Real captured error:

  ```text
  code: "25006"
  message: "cannot execute INSERT in a read-only transaction"
  ```

- **`pnpm scenario:wal-lsn`** (`inspect-wal-and-lsn.ts`) reads
  `pg_current_wal_lsn()` on the primary before and after a 50-row batch,
  computes the byte delta with `pg_wal_lsn_diff()`, and reads
  `pg_stat_replication` on the primary plus `pg_last_wal_replay_lsn()` on
  the replica. Real captured run:

  ```text
  lsnBefore: "0/3060388"
  lsnAfter:  "0/3063508"
  walBytesAdvanced: "12672"
  pg_stat_replication: [{ application_name: "walreceiver", state: "streaming",
    sent_lsn: "0/3063508", write_lsn: "0/3063508",
    flush_lsn: "0/3063508", replay_lsn: "0/3063508", sync_state: "async" }]
  replica: { replay_lsn: "0/3063508", in_recovery: true }
  ```

  Notice `sent_lsn`/`write_lsn`/`flush_lsn`/`replay_lsn` on the primary's
  view of the replica all match the replica's own `pg_last_wal_replay_lsn()`
  exactly - the replica had fully caught up by the time this query ran.

- **`pnpm scenario:artificial-lag`** (`artificial-replication-lag.ts`) - see
  "Break it" below; this is the one scenario that deliberately makes lag
  large enough to be unmissable.
- **PGweb** (http://localhost:8424 primary, http://localhost:8524 replica):
  browse `widgets` on both and confirm they agree once things settle.
- **`docker exec ... psql -c 'SELECT * FROM pg_stat_replication;'`** on the
  primary at any time - this is the single most important operational view
  for replication health.

## Break it

The realistic failure this lab focuses on is **not** a naive-vs-fixed bug in
this lab's own code - Postgres itself refuses the naive mistake outright.
The realistic failure is an operational one: an application gets
misconfigured to point some or all writes at a read replica. This happens
in real production systems, usually via a connection-string/environment
mixup (see Lab 25, which is where this repository actually builds correct
routing).

Reproduce it directly:

```bash
psql "$REPLICA_DATABASE_URL" -c "INSERT INTO widgets (name, value) VALUES ('oops', 1);"
```

```text
ERROR:  cannot execute INSERT in a read-only transaction
```

Postgres itself is the safety net here - there is no way for a physical
standby to silently accept a write and lie about it.

Now make replication lag itself impossible to miss. `pnpm scenario:lag`'s
sub-millisecond numbers above are honest but not dramatic - on a fast local
loopback network with a tiny write volume, real streaming replication
usually keeps up faster than a Node.js poll loop can even observe a gap.
`pnpm scenario:artificial-lag` uses a real, documented Postgres feature
instead of faking anything: `recovery_min_apply_delay`, a standby-only
setting (used in production for deliberate "delayed replica"
disaster-recovery topologies) that tells the replica to wait before
REPLAYING WAL it has already received. The script sets it to `300ms` via
`ALTER SYSTEM` + `pg_reload_conf()`, writes a burst of 50 rows to the
primary, and immediately races a read against the replica for the last row.
Real captured run:

```text
burstDurationMs: 27.32
wasImmediatelyVisible: false
...
pollsUntilVisible: 46
catchUpMs: 303.8
configuredDelayMs: 300
```

The row was genuinely, reproducibly missing from the replica for ~300ms -
a real stale read - and then appeared, matching the configured delay almost
exactly. The script resets `recovery_min_apply_delay` back to `0` in a
`finally` block so every other scenario and test in this lab keeps seeing
normal, fast replication afterward.

## Fix it

There is no code-level "fix" inside this lab in the naive/solution sense -
Postgres already rejects the mistaken write, by itself, for free. The real
fix is architectural and is Lab 25's entire subject: give the application
two separate, clearly named connections (`primaryPool`/`replicaPool`, exactly
as this lab's `src/db/` does) and route every write through the primary
connection by construction, so "point a write at the replica" is not a
mistake that is even reachable from normal application code - not
something caught only by a runtime error from Postgres.

## Why the fix works

Postgres enforces standby read-only-ness in the transaction/execution layer
itself (`SQLSTATE 25006`), independent of any client library, ORM, or
connection pool configuration. That means the guarantee holds even if a
future script, a `psql` session, or a bug in application code forgets to
route correctly - the same "keep guarantees close to the data" principle
this repository has applied since Lab 01's foreign keys, just at the level
of an entire node's role rather than a single constraint.

## Tradeoffs

- **Async streaming replication (this lab's default)**: the primary does
  not wait for the replica to acknowledge before committing, so writes stay
  fast, but a crash on the primary immediately after a commit can lose that
  transaction from the replica's perspective (it may never have received
  the WAL) - see Lab 28 for failover implications.
- **`bitnami/postgresql` vs `postgres:16-alpine`**: bitnami's image trades a
  larger, more opinionated container (extra bootstrap scripts, an `S6`
  supervisor, its own `/opt/bitnami` layout) for replication setup that
  works correctly from environment variables alone. It is a heavier image
  and a different operational surface than every other lab's plain
  `postgres` image - a deliberate, scoped tradeoff for this lab only.
- **`recovery_min_apply_delay` for teaching**: real, not a mock, but it is
  also not how most lag actually shows up in production (which is usually
  driven by network distance, WAL volume, and standby I/O pressure, not a
  deliberately configured delay). Lab 26 explores lag driven by realistic
  load instead of a configured knob.
- **One synchronous replica vs none**: this lab's replica is asynchronous
  (`sync_state: async`), which is why it can lag at all - a synchronous
  replica would make every primary commit wait for replica acknowledgment,
  trading throughput and availability for a stronger durability guarantee.
  Not exercised in this lab.

## Production notes

1. **What guarantee does this technique provide?** Every committed write on
   the primary is eventually replayed on the replica, in the same order it
   was committed on the primary (physical replication preserves WAL order
   exactly).
2. **What does it not guarantee?** Read-after-write consistency on the
   replica (a client can read stale or missing data immediately after its
   own write - see Lab 26), or that a WAL record generated on the primary
   has actually reached the replica before the primary itself crashes
   (async replication can lose recent commits from the replica's view - see
   Lab 28 on failover).
3. **What breaks under process crash?** If the primary crashes before a
   commit's WAL is shipped, that transaction may not exist on the replica
   at all, even though a client was told it committed. If the replica
   crashes, it reconnects and resumes streaming from wherever it left off
   (Postgres tracks this via WAL position, not row state) - this lab's own
   `docker compose down -v && docker compose up -d` cycle exercises the
   "fresh replica bootstraps from scratch" path, not the "replica reconnects
   after a brief outage" path; try `docker compose stop replica && docker
   compose start replica` for that instead.
4. **What breaks under network partition?** A replica that cannot reach the
   primary keeps serving its last-replayed data (stale, but available) - it
   does not error out on reads. The primary keeps accepting writes; WAL
   piles up (`pg_stat_replication` disappears the replica's row) until the
   replica reconnects and catches up, or until WAL retention limits are hit.
5. **What changes at high contention?** Higher write throughput on the
   primary means more WAL generated per second, which the replica must
   receive and replay fast enough to keep lag bounded - see Lab 30 for what
   happens when a large backfill saturates this.
6. **What changes with multiple regions?** Network latency between primary
   and replica becomes the dominant term in replication lag, not local WAL
   volume - a cross-region replica in this same setup would show
   consistently higher `avgLagMs` than the ~2.5ms measured here on loopback.
7. **What metrics would you monitor?** `pg_stat_replication`'s
   `replay_lsn` compared to the primary's `pg_current_wal_lsn()` (lag in
   bytes via `pg_wal_lsn_diff`), replication slot WAL retention size, and
   whether `pg_stat_replication` shows the expected number of connected
   replicas at all (zero rows is itself an incident).
8. **What simpler alternative could be used?** None, for the actual goal of
   "scale reads across nodes with the same data" - logical replication or
   application-level dual writes solve different problems (selective
   replication, cross-version compatibility) at the cost of weaker ordering
   guarantees than physical replication provides here.
9. **When should you avoid this technique?** When you need read-after-write
   consistency on every read (route those reads to the primary instead, per
   Lab 25/26), or when the operational cost of running and monitoring a
   second Postgres node outweighs the read-scaling benefit for your actual
   traffic pattern.

## Interview questions

1. Why does physical streaming replication ship raw WAL records instead of
   replaying the original SQL statements on the replica?
2. What does an LSN actually represent, and why is `pg_wal_lsn_diff()`
   meaningful (i.e., why can LSNs be subtracted like byte offsets)?
3. Why is `sync_state: async` the default, and what would change if this
   replica were `synchronous_commit`-backed instead?
4. A replica's `pg_stat_replication` row disappears from the primary's
   query results. What are the possible causes, and how would you tell
   them apart?
5. Why can't the replica simply "run the same migration" instead of
   replaying WAL to get its schema?
6. If an application accidentally sends a `SELECT ... FOR UPDATE` to a
   replica, what happens, and how is that different from a plain `INSERT`?
7. Why is `recovery_min_apply_delay` a real production feature and not just
   a testing hack - what's it actually used for?

## Further experiments

- Increase `ARTIFICIAL_DELAY_MS` in
  `src/scenarios/artificial-replication-lag.ts` and confirm `catchUpMs`
  tracks it closely.
- Add a second replica (a third bitnami node, `POSTGRESQL_MASTER_HOST:
  primary`, a third port pair) and confirm `pg_stat_replication` on the
  primary now shows two rows.
- Run `docker compose stop replica`, insert several rows on the primary,
  then `docker compose start replica` and watch it catch up - compare this
  reconnect-and-catch-up path to the from-scratch bootstrap path exercised
  by `docker compose down -v`.
- Try setting `POSTGRESQL_SYNCHRONOUS_COMMIT_MODE`-style synchronous
  replication (bitnami exposes this via
  `POSTGRESQL_SYNCHRONOUS_REPLICATION_MODE`/`POSTGRESQL_CLUSTER_APP_NAME`)
  and re-run `pnpm scenario:lag` - does `avgLagMs` change, and does primary
  write latency change?
