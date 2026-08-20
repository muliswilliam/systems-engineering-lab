# Replication Reference

A quick-reference for PostgreSQL physical streaming replication, cross-
referenced to the labs that build and measure each piece against a real
two- or three-node topology. This file is a lookup table; the linked lab's
README has the full setup, the fix, and the tradeoffs.

## WAL and LSN

The **WAL** (write-ahead log) is the durability/replication log Postgres
writes every change to before applying it to the actual data files. An
**LSN** (log sequence number) is a byte-offset-like position within that
log - `pg_wal_lsn_diff(a, b)` subtracts two LSNs the same way you'd
subtract two byte offsets, which is exactly why it's meaningful as a
backlog-size measurement. Physical streaming replication ships raw WAL
records to a standby, which replays them - it does not re-run the original
SQL statements, so the standby ends up byte-identical to the primary's
underlying pages, not merely logically equivalent. See
`labs/24-postgres-wal-and-replication-basics`.

Key functions: `pg_current_wal_lsn()` (primary's current write position),
`pg_last_wal_replay_lsn()` (how far a standby has replayed), and
`pg_stat_replication` (queried **on the primary**) which exposes
`sent_lsn`/`write_lsn`/`flush_lsn`/`replay_lsn` per connected standby.

## Setting up a topology

`bitnami/postgresql` (not this repository's usual `postgres:16-alpine`)
drives primary/standby setup entirely from environment variables
(`POSTGRESQL_REPLICATION_MODE=master|slave`, `POSTGRESQL_MASTER_HOST`,
a shared `POSTGRESQL_PASSWORD`) - see `labs/24-postgres-wal-and-
replication-basics`'s README for the full rationale on why this repository
deviates from its normal image here, and for a real bitnami gotcha worth
knowing: a `slave`-mode node never gets a `pg_hba.conf` entry permitting
*incoming* replication connections (the image assumes a slave is always a
leaf) - a cascading replica (below) needs a custom `pg_hba.conf` mounted
onto the middle-tier node to work around this.

**Confirm replication is real, always, before trusting anything else**:

```sql
SELECT application_name, state, sync_state FROM pg_stat_replication;
```

Zero rows means no standby is connected at all - that is itself an
incident, not a quiet state.

## Read-write routing (application-level)

Postgres itself refuses a write against a standby (`SQLSTATE 25006`,
"cannot execute INSERT in a read-only transaction") - that half is free.
The hard half is entirely on the application: given two live connections,
classify every operation into one of four kinds and route accordingly. See
`labs/25-primary-read-replica-routing`.

| Operation kind | Route to | Why |
|---|---|---|
| write | primary | the replica rejects it outright |
| ordinary read | replica | no freshness requirement |
| read-after-write | primary (simplest) or LSN-gated replica read | the replica may not have replayed your own just-committed write yet |
| transaction | primary | a Postgres transaction cannot span two connections/nodes - even a plain `SELECT ... FOR UPDATE` inside one is a WAL-logging (write-adjacent) operation and gets the same `25006` |

A naive router that sends every read (including read-after-write) to the
replica produces an **intermittent** staleness bug (real measured
`staleRate: 0.05` at zero artificial delay) - dangerous precisely because
it is not reliably reproducible. PgBouncer (`labs/23-connection-management-
and-pgbouncer`) does **not** do this routing for you; it pools connections
to one backend, with no concept of "send this query to a different node."

## Read-after-write strategies

Three complementary strategies exist once "just read the primary" isn't
the whole answer - see `labs/25` and `labs/26-replication-lag-and-read-
after-write`:

1. **Sticky primary** - route any read that follows a recent write by the
   same session to the primary for a bounded window. Simple, always
   correct while the window holds, but the window is a *guess*: a window
   shorter than real lag reintroduces the bug (real captured proof:
   `staleAfterWindowExpired: true` with a 250ms window against 400ms real
   lag).
2. **LSN-gated read** - capture `pg_current_wal_lsn()` right after the
   write, then poll the replica's `pg_last_wal_replay_lsn()` until it is
   `>=` that value before reading the replica. Always correct for that
   specific write and adapts automatically to real lag (measured
   `avgWaitMs: 403.2` against a real 400ms delay, `avgWaitMs: 0.4` with no
   delay) - the cost is a blocking wait on the read path.
3. **Bounded staleness** - measure aggregate replica backlog
   (`pg_wal_lsn_diff`, **not** `replay_lag`, see the gotcha below) before
   every read and fall back to the primary only past a threshold. Cheap,
   no per-write bookkeeping, but it's a policy about acceptable *aggregate*
   staleness, not a per-write guarantee.

**A real, load-bearing gotcha**: `pg_stat_replication.replay_lag` (the
time-based interval) can under-report real lag, because it only updates
once a standby has actually replayed a record and reported that
confirmation back - under an active `recovery_min_apply_delay`, that
confirmation is itself withheld, so the interval reads as near-zero while a
real backlog silently builds. The byte-based `pg_wal_lsn_diff(pg_current_wal
_lsn(), replay_lsn)` has no such lag-behind-the-lag problem; route bounded-
staleness decisions on bytes, not the interval.

`recovery_min_apply_delay` (a real, standby-only Postgres setting used for
deliberate "delayed replica" DR topologies) is what these labs use to make
lag large and deterministic enough to reproduce reliably, instead of racing
a genuinely sub-millisecond window on a fast local network.

## Cascading replicas

A standby can itself be the upstream for another standby
(`primary -> replica-1 -> replica-2`), using the identical physical
streaming mechanism just chained - a standby's WAL sender process does not
know or care whether it is itself in recovery. See `labs/27-cascading-
replicas`.

- **`pg_stat_replication` is always a "who is downstream of the node I just
  queried" view, never global.** The primary's own count of connected
  standbys never grows as more replicas are chained further down - that is
  the entire architectural point (reduced primary fan-out).
- **A surprising non-composition**: `recovery_min_apply_delay` set to
  150ms on *both* tiers of a cascade does **not** produce ~300ms of total
  lag (measured: ~155ms, barely more than one hop) - the delay is anchored
  to the WAL record's original *commit timestamp* on the primary, not to
  each hop's own receipt time, so both tiers are independently racing
  toward nearly the same target.
- **The middle tier is a real single point of failure with no automatic
  rerouting**: stop the middle-tier node and every replica below it stops
  receiving new data entirely - not degraded, a hard stop - until the
  middle tier itself recovers, at which point it automatically re-forwards
  its backlog with no manual intervention.

## Failover

Postgres has **no built-in automatic failover**. A standby with no primary
to stream from waits forever - nothing detects the outage or promotes
anything on its own. See `labs/28-failover-and-role-changes`.

`SELECT pg_promote(true, wait_seconds)` (Postgres 12+, SQL-callable) is the
mechanism; something outside Postgres (a human, or real HA tooling -
Patroni, repmgr, pg_auto_failover) must decide *when* to call it. Real
measured write-unavailability gap in this repository's own tests: ~125ms
from confirmed-primary-down to first-successful-write-anywhere, almost
entirely the `pg_promote()` call itself (~111ms) - a **best case**, since it
has zero human/tooling decision latency built in; real incidents spend most
of the unavailability window on *deciding* the primary is really gone, not
on the mechanical promotion.

**Split-brain is a real, reproducible risk, not hypothetical**: naively
restarting the old (stopped) primary after a promotion resumes it as an
independent, writable primary with its own diverged WAL history - both
nodes report `pg_is_in_recovery() = false` and each accepts writes the
other will never see. Fixing this needs `pg_rewind` (rewind to the last
common checkpoint) or a fresh base backup - never a plain restart.

**What promotion does *not* do automatically**: it does not repoint
application connection strings at the new primary (that's a proxy/DNS/
service-discovery concern, or Lab 25's router if it's told the identity
changed), and it does not reconnect that node's own downstream cascading
replicas (Lab 27) to the new topology.

## See also

- `docs/lock-reference.md` - locking is a single-primary-node concept;
  nothing here applies across a replica.
- `docs/transaction-anomalies.md` - the SQL-standard anomalies, distinct
  from replica staleness (which is not one of them).
- `labs/24-postgres-wal-and-replication-basics` through
  `labs/28-failover-and-role-changes` - the full reproductions.
