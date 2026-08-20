# Lab 26 - Replication Lag and Read-After-Write

## Why this exists

Lab 24 proved physical streaming replication genuinely works and measured
real lag. Lab 25 built the routing plumbing (`primaryPool`/`replicaPool`,
writes-go-to-primary-by-construction). Neither of those labs answers the
question that actually bites production teams: **a user submits a write and
is immediately shown a page that reads their own data back - what happens
when that read lands on a replica that has not caught up yet?**

```text
POST /profile         -> UPDATE user_profiles SET display_name = ... (primary)
redirect
GET /profile          -> SELECT ... FROM user_profiles (replica)
                          "wait, where did my name change go?"
```

This is one of the most common real-world replication incidents: not
"replication is broken," but "replication is working exactly as designed,
and a user's own write vanished for a fraction of a second." This lab
reproduces that bug with real, repeated, captured evidence, then implements
and measures three concrete mitigation strategies against a real replica
under real, deterministically-induced lag.

## Learning objectives

After this lab you should be able to:

- reproduce the read-after-write consistency problem with real captured
  stale reads, not a hypothetical description of it;
- implement and reason about the tradeoffs of three concrete mitigation
  strategies: read-your-writes-to-primary, LSN-gated reads, and bounded
  staleness;
- use `pg_current_wal_lsn()` / `pg_last_wal_replay_lsn()` to block a read
  until a SPECIFIC write is genuinely visible on a replica;
- use `pg_stat_replication` to make a real-time routing decision based on
  current replication backlog;
- explain why a time-based lag signal (`replay_lag`, an interval) and a
  byte-based lag signal (`pg_wal_lsn_diff`) can disagree at the exact moment
  you need one, and why that matters for which one you route on;
- explain what each strategy actually guarantees, what it costs, and when a
  "cheap but occasionally wrong" strategy is the correct engineering
  tradeoff versus a "always right but does not scale" one.

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

Same two-node `bitnami/postgresql` shape as Lab 24 (see that lab's README
"Architecture" for the full rationale on why `bitnami/postgresql` is used
instead of this repository's usual `postgres:16-alpine`) - but this is a
fully independent lab: its own `docker-compose.yml`, its own containers
(`lab26-primary`/`lab26-replica`/`lab26-pgweb-primary`/`lab26-pgweb-replica`),
its own named volumes, its own ports, its own database (`lab26`), and no
shared Docker network with Lab 24 or Lab 25.

Domain: a single, deliberately small `user_profiles` table (`id` bigint
identity, `public_id` uuid, `display_name`, `bio`, `updated_at`) - not one of
SPEC.md section 8.2's five named domains. This mirrors SPEC.md's own Lab 26
scenario directly (a user profile edit), and a richer relational model would
only add noise around the read-after-write mechanics being taught - same
"small standalone table, the lesson is the mechanism" rationale as Lab 06's
`counters`/Lab 24's `widgets`.

Every scenario in this lab shares one small library,
`src/lib/replication-control.ts`:

- `setReplicaApplyDelay(pool, delayMs)` - the same real
  `recovery_min_apply_delay` mechanism Lab 24 uses, applied via `ALTER
  SYSTEM` + `pg_reload_conf()` on the replica. This is a real, documented
  Postgres standby feature (used in production for deliberate "delayed
  replica" disaster-recovery topologies), not a fake sleep - it is what
  makes lag large enough (~400ms here) to observe deterministically across
  repeated trials instead of racing a sub-millisecond window.
- `getPrimaryWalLsn(pool)` / `waitForReplicaLsnAtLeast(pool, targetLsn, ...)`
  - Strategy B's blocking primitive: capture the primary's WAL position
    right after a write, then poll the replica's own
    `pg_last_wal_replay_lsn()` until it has genuinely caught up to that
    exact point.
- `getReplicationLagFromPrimary(pool)` - Strategy C's measurement primitive:
  reads `pg_stat_replication` on the primary (the same shape as
  `packages/db-utils/sql/show-replication-lag.sql`) and returns both a
  byte-based backlog size (`pg_wal_lsn_diff`) and a time-based interval
  (`replay_lag`). **These two numbers do not agree at the moment you most
  need them** - see "Observe" below for the real, captured reason why this
  lab routes on bytes, not the interval.

## Setup

```bash
pnpm install
cp labs/26-replication-lag-and-read-after-write/.env.example labs/26-replication-lag-and-read-after-write/.env
cd labs/26-replication-lag-and-read-after-write
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate    # applies ONLY to the primary
pnpm seed          # writes ONLY to the primary
```

Confirm the topology is actually replicating before doing anything else:

```bash
docker exec -e PGPASSWORD=lab26 lab26-primary \
  psql -U postgres -d lab26 -c \
  "SELECT application_name, state, sync_state FROM pg_stat_replication;"
```

Real captured output from this lab's own validation run:

```text
 application_name |   state   | sync_state
-------------------+-----------+------------
 walreceiver      | streaming | async
(1 row)
```

Open PGweb for the primary at http://localhost:8426 and for the replica at
http://localhost:8526.

## Scenario

Every scenario script in this lab follows the same shape: write a new
`display_name` to a seeded `user_profiles` row on the **primary**, then
immediately attempt to read that same row's `display_name` back - exactly
like a user being redirected from `POST /profile` to `GET /profile`. What
differs between scripts is *where that read is routed from* and *what, if
anything, it waits for first*.

## Prediction

Before running anything, predict:

1. With a real 400ms `recovery_min_apply_delay` active on the replica, if
   you `UPDATE` a row on the primary and immediately `SELECT` it on the
   replica (no wait), will you ever see the new value? Always? Never?
   Sometimes?
2. Strategy B (LSN-gated read) blocks until the replica has replayed a
   specific LSN. Under the same 400ms delay, roughly how long should that
   block take? What about with no delay at all?
3. Strategy C measures replication lag before deciding where to read from.
   `pg_stat_replication` exposes both a byte-based backlog
   (`pg_wal_lsn_diff`) and a time-based interval (`replay_lag`). Do you
   expect these two numbers to always agree?

## Exercise

```bash
pnpm scenario:naive        # reproduce the bug
pnpm scenario:strategy-a   # read-your-writes routed to the primary
pnpm scenario:strategy-b   # LSN-gated read
pnpm scenario:strategy-c   # bounded staleness (byte-based backlog threshold)
```

Read each script's structured log output in full - every number reported is
real and freshly measured on your own machine, not copied from this file.

## Observe

**`pnpm scenario:naive`** (`naive-stale-read-after-write.ts`) - 20 trials,
each: `UPDATE` on primary, then an immediate, unguarded `SELECT` on the
replica. Real captured run, with a 400ms `recovery_min_apply_delay` active:

```text
trials: 20
staleCount: 20
staleRatePercent: 100
```

Every single trial's read returned the OLD `display_name` - the user's own
write had genuinely, repeatably vanished, `msSinceCommit` values around
0.2-0.9ms confirming the read landed a fraction of a millisecond after
commit, nowhere close to the 400ms replay delay.

**`pnpm scenario:strategy-a`** (`strategy-a-sticky-primary.ts`) - Part 1
routes the same kind of read straight to the primary instead. Real captured
run, same 400ms delay:

```text
Part 1: trials: 20, correctCount: 20, correctRatePercent: 100
```

Always correct - the read never touches the lagging replica. Part 2 then
deliberately uses a **too-short** sticky window (250ms) against the same
400ms real delay, to show the strategy's real limit:

```text
staleAfterWindowExpired: true
```

The window "expired" (the app decided it was safe to route back to the
replica) before real replication had actually caught up - a stale read
happened anyway. The window is a guess about lag duration, not a
measurement of it.

**`pnpm scenario:strategy-b`** (`strategy-b-lsn-gated-read.ts`) - captures
`pg_current_wal_lsn()` right after each write and blocks on the replica's
`pg_last_wal_replay_lsn()` until it catches up. Real captured run:

```text
Part 1 (400ms delay):    trials: 15, correctCount: 15, avgWaitMs: 403.2
Part 2 (no delay):       trials: 15, correctCount: 15, avgWaitMs: 0.4
```

Always correct in both parts - the difference is entirely in how long the
read had to wait, and that wait tracks the REAL delay almost exactly
(403.2ms measured against a configured 400ms), not a fixed guess.

**`pnpm scenario:strategy-c`** (`strategy-c-bounded-staleness.ts`) - measures
`pg_stat_replication` before every read and routes to the primary only if
the measured backlog exceeds a threshold. Real captured run:

```text
Part 1 (400ms delay, 100-byte threshold): fallbackToPrimaryCount: 15/15, correctCount: 15/15
Part 2 (no delay,   100-byte threshold): fallbackToPrimaryCount: 0/15,  correctCount: 15/15
```

The fallback triggers on every trial under real lag, and on zero trials once
the artificial delay is removed - the same threshold logic, reacting to
genuinely different measured states, not two different code paths.

**A real, important gotcha this lab's own validation run surfaced:** the
first implementation of Strategy C routed on `pg_stat_replication.replay_lag`
(an interval, milliseconds) instead of the byte-based backlog. Under the
same 400ms `recovery_min_apply_delay`, the FIRST few measured `replay_lag`
values came back as **0.86ms, 5.4ms, 9.5ms, ...** - climbing slowly from
near-zero across the trial loop, never anywhere close to 400ms within the
~50ms the whole loop took to run, and the fallback never triggered at all.
This is not a bug in Postgres, and not a mistake in the delay setting - it
is a real property of that column: `replay_lag` only updates once the
standby has actually REPLAYED a WAL record and reported that confirmation
back to the primary. Under an active `recovery_min_apply_delay`, that
confirmation is itself withheld, so the interval genuinely reads as small
while a real backlog is silently building up. The byte-based
`pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)` has no such
lag-behind-the-lag problem - it reflects the real-time WAL backlog size
immediately, which is why this lab's Strategy C routes on bytes. See
`src/lib/replication-control.ts`'s doc comments for the full explanation -
this is exactly the kind of "do not present a simpler picture than reality"
precision CLAUDE.md requires, kept in the code, not just this file.

- **PGweb** (http://localhost:8426 primary, http://localhost:8526 replica).
- **`docker exec ... psql -c 'SELECT * FROM pg_stat_replication;'`** at any
  time during a scenario run - watch `replay_lag` and compute
  `pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)` yourself while
  `pnpm scenario:strategy-c` is running.

## Break it

Run `pnpm scenario:naive` yourself and watch every one of the 20 trials
report `isStale: true`. Then open two `psql` sessions manually:

```bash
psql "$REPLICA_DATABASE_URL" -c \
  "ALTER SYSTEM SET recovery_min_apply_delay = '2000ms'; SELECT pg_reload_conf();"
psql "$PRIMARY_DATABASE_URL" -c \
  "UPDATE user_profiles SET display_name = 'manual-break-it' WHERE id = (SELECT MIN(id) FROM user_profiles);"
psql "$REPLICA_DATABASE_URL" -c \
  "SELECT display_name FROM user_profiles WHERE id = (SELECT MIN(id) FROM user_profiles);"
```

The replica's `SELECT` will show the OLD value for up to 2 real seconds.
Reset it afterward:

```bash
psql "$REPLICA_DATABASE_URL" -c \
  "ALTER SYSTEM SET recovery_min_apply_delay = '0'; SELECT pg_reload_conf();"
```

## Fix it

Three real fixes, in increasing sophistication:

1. **Strategy A** (`strategy-a-sticky-primary.ts`) - route any read that
   follows a recent write by the same session/user straight to the primary.
   Simplest possible fix, always correct while the sticky window is
   observed, but the window is a guess and does not scale reads (every
   "recently active" user's reads pile back onto the primary).
2. **Strategy B** (`strategy-b-lsn-gated-read.ts`) - capture the primary's
   LSN at write time, block on the replica until it has replayed at least
   that far, then read the replica. Always correct for the SPECIFIC write,
   adapts automatically to real lag (waits ~0ms when lag is low, ~400ms when
   it is high) - but it is a blocking wait on the request path, so tail
   latency is bounded by however long that specific replica takes to catch
   up.
3. **Strategy C** (`strategy-c-bounded-staleness.ts`) - measure aggregate
   replica backlog before every read and fall back to the primary only when
   it exceeds a threshold. Cheap (no blocking, no per-write LSN bookkeeping)
   and correct for "this page can tolerate boundedly-stale data," but it is
   a policy about acceptable overall staleness, not a per-write guarantee -
   a read that lands in the tiny window right after the threshold check but
   before a write completes could still theoretically see stale data for a
   DIFFERENT row than the one just measured.

## Why the fix works

Strategy A works because the read simply never touches the node that could
be lagging - correctness is structural, not probabilistic. Strategy B works
because it ties the wait directly to the one fact that actually matters (has
THIS write's LSN been replayed), verified via Postgres's own WAL position
functions, not a client-side timer. Strategy C works because
`pg_stat_replication`'s byte-based backlog is a real-time, Postgres-native
signal - no different in kind from the row-lock and conditional-write
patterns this repository has used since Lab 10/11 to keep an invariant close
to the data that owns it, just applied to a node-level staleness invariant
instead of a row-level one.

See `docs/replication-reference.md` for a cross-lab quick-reference on
read-after-write strategies and the other replication labs.

## Tradeoffs

| Strategy | Correctness guarantee | Read cost | Scales? | Needs tuning? |
|---|---|---|---|---|
| Naive (no strategy) | None | Cheapest | Yes, but wrong | N/A |
| A - sticky primary | Correct while window holds | Primary read cost | No (writes pile onto primary) | Window duration must exceed real lag |
| B - LSN-gated | Always correct for this write | Blocking wait, bounded by real lag | Partially (still blocks) | None - adapts automatically |
| C - bounded staleness | Correct as long as aggregate lag estimate is accurate | One extra lightweight query | Yes | Threshold value, and which signal (bytes vs. interval) it is measured on |

## Production notes

1. **What guarantee does this technique provide?** Strategy A/B: real,
   per-write read-after-write consistency for the specific write being
   guarded. Strategy C: a bounded-staleness SLA at the aggregate replica
   level, not a per-write guarantee.
2. **What guarantee does it not give?** None of these strategies make the
   REPLICA itself catch up any faster - they only change which node answers
   a given read, or how long a specific read is willing to wait. A replica
   under sustained real overload can still fail Strategy B's timeout or
   Strategy C's threshold continuously, at which point all reads for that
   page degrade to hitting the primary - see "what changes at high
   contention" below.
3. **What breaks under process crash?** If the process crashes between the
   primary write and the read-after-write check (any strategy), the pending
   read simply never happens - there is no partial state to corrupt, since
   none of these strategies write anything themselves.
4. **What breaks under network partition?** If the replica becomes
   unreachable, Strategy B's poll loop and Strategy C's lag query both fail
   outright (this lab's `waitForReplicaLsnAtLeast`/`getReplicationLagFromPrimary`
   will throw/return no rows) - production code must decide whether "replica
   unreachable" degrades to "always use primary" (safe) or surfaces an
   error (safer for correctness, worse for availability).
5. **What changes at high contention?** Under sustained high write volume,
   real replication lag grows for reasons unrelated to any single write
   (network saturation, replica I/O pressure, WAL volume) - Strategy B's
   wait times grow with it (worse tail latency on every read-after-write
   path), and Strategy C's fallback rate rises (more reads pile onto the
   primary, which is itself already under write pressure - a feedback loop
   worth monitoring, not assuming away).
6. **What changes with multiple regions?** A cross-region replica's baseline
   lag is dominated by network RTT, not local replay speed - Strategy B's
   "adapts automatically" property is exactly what matters here (it won't
   wait an artificial fixed amount, but it will genuinely wait however long
   the real cross-region lag requires), while Strategy A's sticky window
   needs to be tuned per-topology or it silently under-protects.
7. **What metrics would you monitor?** Per-strategy: Strategy A - sticky
   window hit/miss rate (how often a read after the window still landed
   stale, if you can detect it); Strategy B - p50/p95/p99 wait time (this
   IS your read-after-write tail latency budget); Strategy C - fallback
   rate over time (a rising fallback rate is an early replica-health signal,
   not just a routing detail) and, per this lab's own finding, BOTH the
   byte-based backlog and the `replay_lag` interval, since they can
   disagree and that disagreement is itself diagnostic.
8. **What simpler alternative could be used?** If your workload can afford
   it, route ALL reads to the primary and skip replicas entirely for
   session-critical data - simpler than any of these three strategies, at
   the cost of the read scaling replicas exist to provide.
9. **When should you avoid this technique?** Strategy B (blocking) should be
   avoided on latency-critical hot paths if lag is often large - a fixed
   short timeout with graceful fallback to the primary is usually safer
   than blocking indefinitely. Strategy C should be avoided for anything
   where a single stale byte is unacceptable (e.g. displaying a payment
   confirmation) - use Strategy A or B there instead.

## Interview questions

1. Why does `pg_stat_replication.replay_lag` sometimes under-report real
   lag while `pg_wal_lsn_diff`-based backlog does not, under an active
   `recovery_min_apply_delay`? Would the same discrepancy show up under
   "normal" production lag (network/I/O-driven, not an artificial delay)?
2. Strategy B blocks on the READ path. What would change if you instead
   blocked on the WRITE path (i.e., wait for synchronous replication
   acknowledgment before returning from the write)? Which is usually
   preferable, and why?
3. Strategy A's sticky window is a client-side guess. What would it take to
   make that guess self-tuning based on observed lag instead of a fixed
   constant?
4. Why is Strategy C's guarantee described as "bounded staleness" rather
   than "read-after-write consistency"? Give a concrete example of a read
   that could still be wrong under Strategy C.
5. If a single logical user has multiple devices/tabs open, does
   "read-your-writes" for THAT user's own write on one device also need to
   apply to their reads on a different device? What does that imply about
   where session-affinity state should live?
6. How would you extend Strategy B to avoid blocking the HTTP response
   itself (e.g., return immediately and let the client poll, or use a
   short bounded wait with fallback)?
7. What operational signal would tell you Strategy C's threshold is set too
   low (falling back too often) versus too high (serving staleness users
   actually notice)?

## Further experiments

- Change `ARTIFICIAL_DELAY_MS` in each scenario and confirm Strategy B's
  `avgWaitMs` tracks it.
- In `strategy-a-sticky-primary.ts`, set `STICKY_WINDOW_MS` above
  `ARTIFICIAL_DELAY_MS` and confirm Part 2's stale-after-expiry outcome
  stops reproducing.
- In `strategy-c-bounded-staleness.ts`, try routing on `replayLagMs` instead
  of `replayLagBytes` and reproduce this lab's own captured "lag behind the
  lag" finding for yourself.
- Add a fourth strategy: a short, BOUNDED version of Strategy B (poll for at
  most, say, 50ms; fall back to the primary if it doesn't catch up by then)
  and measure how its correctness rate changes as you vary
  `ARTIFICIAL_DELAY_MS` above and below that bound.
- Point two concurrent Node processes at this same lab (one running
  `scenario:naive`, one running `scenario:strategy-b`) and watch them
  interleave against the same replica's real, shared lag state.
