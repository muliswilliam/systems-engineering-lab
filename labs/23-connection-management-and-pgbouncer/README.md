# Lab 23 - Connection Management and PgBouncer

## Why this exists

Every Postgres connection is a full OS backend process on the server, not a
cheap lightweight handle. `max_connections` is a hard ceiling - once it is
reached, Postgres does not queue new connection attempts, it rejects them
outright with `FATAL: sorry, too many clients already`. Applications that
open one connection (or one connection pool) per process, per request, or
per worker eventually collide with that ceiling under real traffic, long
before the database itself is under any meaningful query load. PgBouncer
sits in front of Postgres and multiplexes many client connections onto a
small, fixed number of real backend connections - but it does this by
changing what "your connection" means, and that change has real,
observable consequences for anything that depends on session state
(`SET`, temp tables, prepared statements, advisory locks).

## Learning objectives

After this lab you should be able to:

- reproduce real Postgres connection exhaustion (`SQLSTATE 53300`) with
  direct connections, and explain why it is a hard ceiling, not a soft one;
- explain what PgBouncer actually does (multiplex client connections onto a
  smaller pool of server connections) and what it explicitly does NOT do
  (read/write routing - CLAUDE.md is explicit about this);
- compare PgBouncer's session pooling and transaction pooling modes and
  state, precisely, what each one guarantees about backend continuity;
- name concrete kinds of session state (custom GUCs, temp tables, prepared
  statements, advisory locks) that break under transaction pooling, and
  explain why application_name specifically does NOT break (PgBouncer
  tracks and replays it);
- explain why `default_pool_size` is a real, measurable throughput/queueing
  tradeoff, not a "bigger is always better" knob;
- explain why DDL and migrations should run directly against Postgres, not
  through a transaction-pooling PgBouncer.

## Architecture

```text
                          ┌──────────────────────────┐
  application code  ─────▶│ pgbouncer-session (6323) │──┐
  (long sessions,         │      pool_mode=session    │  │
   psql, admin tools)     └──────────────────────────┘  │
                                                          ▼
                          ┌──────────────────────────┐  ┌────────────┐
  application code  ─────▶│pgbouncer-transaction(6324)│─▶│ PostgreSQL │◀── pgweb
  (short, stateless       │    pool_mode=transaction  │  │  (5423)    │   (8423,
   queries)               └──────────────────────────┘  └────────────┘    direct)
                                                          ▲
  migrate.ts / seed.ts ───────────────────────────────────┘
  (direct, bypasses PgBouncer entirely)
```

PgBouncer's `pool_mode` is one setting per instance (per database, in this
lab's single-database setup) - there is no single instance that runs
session pooling for one client and transaction pooling for another at the
same time. To compare both modes side by side against identical data, this
lab runs **two PgBouncer instances**, `pgbouncer-session` and
`pgbouncer-transaction`, both pointed at the same Postgres. We considered a
single PgBouncer process with two `[databases]` entries in one
`pgbouncer.ini` (e.g. `lab23_session` and `lab23_transaction`, each
resolving to the same physical database with different pool modes) - it
would work and use one fewer container, but two full instances on two
ports makes the comparison read unambiguously in both `docker-compose.yml`
and this README, and mirrors how you would actually deploy this in
production (a session-pool endpoint for tools that need it, a
transaction-pool endpoint for the application).

**PgBouncer image choice**: this lab uses `edoburu/pgbouncer` (a
well-maintained, widely used image that generates `pgbouncer.ini` and
`userlist.txt` from environment variables) rather than hand-authoring
config files and mounting them into the official `pgbouncer/pgbouncer`
image. For a lab whose whole point is comparing a handful of top-level
settings (`POOL_MODE`, `DEFAULT_POOL_SIZE`, `MAX_CLIENT_CONN`) across two
instances, environment variables in `docker-compose.yml` are more readable
than two near-identical `.ini` files - see `docker-compose.yml` for the
exact environment variables used, and the `entrypoint.sh` this lab read
directly from the image (`docker run --rm --entrypoint cat
edoburu/pgbouncer /entrypoint.sh`) to confirm exactly which environment
variables it recognizes.

**PgBouncer does not do read/write routing.** It pools and multiplexes
connections. Both PgBouncer instances in this lab point at the exact same
single Postgres instance - there is no primary/replica split here at all
(that is Lab 25's subject). Routing reads to a replica and writes to a
primary is a separate concern that has to be implemented at the
application or a purpose-built proxy layer, not assumed to come for free
from a connection pooler.

Domain: a fresh, minimal `widgets` table (id, public_id, name, value) -
this lab is about connection and pooling mechanics, not data modeling, so
one small table is enough.

## Setup

```bash
pnpm install
cp labs/23-connection-management-and-pgbouncer/.env.example labs/23-connection-management-and-pgbouncer/.env
cd labs/23-connection-management-and-pgbouncer
docker compose up -d
pnpm db:migrate   # runs directly against Postgres - see "Why the fix works"
pnpm seed
```

Verify all four services are healthy and reachable:

```bash
docker compose ps
psql "$DATABASE_URL" -c "select 1;"                        # direct
psql "$DATABASE_URL_PGBOUNCER_SESSION" -c "select 1;"       # via pgbouncer-session
psql "$DATABASE_URL_PGBOUNCER_TRANSACTION" -c "select 1;"   # via pgbouncer-transaction
```

Open PGweb at http://localhost:8423 (it connects directly to Postgres, not
through either PgBouncer instance - see "Why the fix works" for why).

## Scenario

An application currently opens one direct Postgres connection (or one
connection-pool member) per unit of concurrent work. Under light load this
is invisible. Under a burst of concurrent requests - a traffic spike, a
batch job, a fleet of workers scaling out - the number of concurrent
connections can exceed Postgres's `max_connections` long before the
database's CPU or disk is the bottleneck. This lab reproduces that failure
directly, then introduces PgBouncer as the fix for the common case (short,
stateless queries), while being explicit about what breaks when an
application that assumes "my connection" is a single stable object
(session variables, temp tables, prepared statements, advisory locks) sits
behind a transaction-pooling PgBouncer instead.

This lab deliberately lowers Postgres's `max_connections` from its built-in
default of 100 down to 30 (`POSTGRES_MAX_CONNECTIONS` in `.env.example`).
That is not required to reproduce the failure in principle - the same
thing happens at 100 - but at 100 you would need to reliably open 120-150+
real OS-level connections concurrently to see it, which is slow, sensitive
to host file-descriptor limits, and unreliable in CI. At 30, 50 concurrent
attempts reproduces the exact same failure in well under half a second,
every time.

## Prediction

Before running anything, predict:

1. With `max_connections=30`, what happens to the 31st concurrent direct
   connection attempt - does it queue, get silently dropped, or fail
   loudly with a specific error?
2. Through the transaction-pooling PgBouncer instance, can 60 concurrent
   "client connections" succeed at the same time, even though Postgres's
   `max_connections` is only 30? Why or why not?
3. If a client runs `SET application_name = 'foo'` and then, later, runs
   `SHOW application_name` through the transaction-pooling instance, will
   it reliably see `'foo'`?
4. If that same client instead runs `PREPARE p AS SELECT 1` and then, later,
   `EXECUTE p`, will it reliably succeed?

## Exercise

1. Run the setup commands above.
2. Run `pnpm scenario:direct-overload` and read the summary log - note
   `succeeded`, `rejected`, and `tooManyClientsAlready`.
3. Run `pnpm scenario:transaction-pooling` and compare `succeeded` against
   `peakConcurrentBackends` - the second number is measured directly from
   `pg_stat_activity` on Postgres, not just asserted.
4. Run `pnpm scenario:session-vs-transaction` and compare the
   `sessionPreservedCount` / `transactionPreservedCount` summary at the end.
5. Run `pnpm scenario:pool-size-tuning` and compare
   `smallPoolWallClockMs` against `largePoolWallClockMs`.

## Observe

- **`docker compose logs postgres`**: `log_connections=on` /
  `log_disconnections=on` make every real backend process's lifecycle
  visible.
- **`pg_stat_activity`** (direct connection): `select count(*), usename,
  datname from pg_stat_activity group by usename, datname;` - watch this
  while a scenario script runs in another terminal.
- **PgBouncer's own admin console** (a virtual `pgbouncer` database, not
  this lab's `lab23` database): `psql "$DATABASE_URL_PGBOUNCER_TRANSACTION"
  -d pgbouncer -c "SHOW POOLS;"` and `SHOW CLIENTS;` / `SHOW SERVERS;` -
  see `src/db/pgbouncer-admin.ts` and `playground/notes.md`.
- **Structured logs**: every scenario logs a `workerId`/`trial` and a
  `backendPid` per attempt through `@labs/logging` (Pino), so you can see
  exactly which real Postgres backend served which logical client.

## Break it

Run the direct-connection scenario:

```bash
pnpm scenario:direct-overload
```

Real captured output from this lab (`POSTGRES_MAX_CONNECTIONS=30`, 50
concurrent direct connection attempts, each holding its connection open
briefly so they are genuinely concurrent at the server):

```text
concurrentConnections: 50
wallClockMs: 364
succeeded: 29
rejected: 21
tooManyClientsAlready: 21
```

Every one of the 21 rejections carried the real Postgres error:

```text
FATAL: sorry, too many clients already   (SQLSTATE 53300)
```

Note `succeeded` (29) is one below `max_connections` (30) - Postgres
reserves its very last slot-equivalent headroom for administrative/
superuser connections and this lab's own migration/seed connections were
already closed by the time the burst ran, so the exact number varies
slightly run to run depending on what else briefly held a connection; the
important, reliable fact is that a meaningful fraction of a 50-connection
burst is rejected outright once `max_connections` is exceeded, not queued
or degraded gracefully.

## Fix it

For short, stateless queries - the common case for most application
traffic - route through the transaction-pooling PgBouncer instance instead
of connecting to Postgres directly:

```bash
pnpm scenario:transaction-pooling
```

Real captured output, same style of burst (60 concurrent client
connections, well beyond `max_connections=30`), through
`pgbouncer-transaction` (`default_pool_size=10`):

```text
concurrentClients: 60
wallClockMs: 585
succeeded: 60
peakConcurrentBackends: 10
distinctBackendPidCount: 10
```

All 60 succeeded. A background monitor connected directly to Postgres and
polled `pg_stat_activity` throughout the burst (see
`src/scenarios/pgbouncer-transaction-pooling.ts`) and never observed more
than 10 real backend connections in use at once - exactly
`default_pool_size`. PgBouncer multiplexed 60 logical client connections
onto 10 real Postgres backends, well under Postgres's own
`max_connections=30`.

**What you give up**: transaction pooling only guarantees a client keeps
its backend connection for the duration of one transaction. The moment
that (possibly implicit) transaction commits, PgBouncer is free to hand
that backend to a different client and give yours a different one for its
next statement. `pnpm scenario:session-vs-transaction` demonstrates this
concretely with three kinds of session-scoped Postgres state that PgBouncer
does not special-case: a custom GUC (`SET myapp.session_marker = ...`), a
`CREATE TEMP TABLE`, and a server-side `PREPARE`d statement. Real captured
output (5 trials per mode, each followed by a burst of 15 unrelated "noise"
clients before checking):

```text
sessionPreservedCount: 5    (of 5 trials)
transactionPreservedCount: 0   (of 5 trials)
```

Every transaction-pooling trial in this run landed on a genuinely different
backend PID for its later check, and every check failed with a real,
distinct Postgres error:

```text
ERROR: unrecognized configuration parameter "myapp.session_marker"
ERROR: relation "lab23_probe_<uuid>" does not exist
ERROR: prepared statement "lab23_stmt_<uuid>" does not exist
```

Every session-pooling trial kept the exact same backend PID for its entire
client session and all three checks always succeeded.

**A negative result worth knowing**: `SET application_name = ...` is a bad
marker for this experiment. PgBouncer specifically tracks a small, fixed
set of startup-style parameters - `application_name` among them - and
automatically replays them onto whichever real backend ends up serving a
client next, in every pool mode, including transaction. This scenario's
`src/scenarios/session-pooling-vs-transaction-pooling.ts` documents that
finding in detail; it is why the scenario uses a custom GUC, a temp table,
and a prepared statement instead.

**Another real caveat found while building this lab**: because transaction
pooling does not run a reset query (`DISCARD ALL`) when a backend goes back
to the pool - that only happens by default for session pooling - a backend
can carry a *different, unrelated* client's leftover prepared statement or
temp table. Early drafts of the session-vs-transaction scenario used a
fixed name for the temp table/prepared statement across every trial and
got spurious `prepared statement "..." already exists` errors, plus false
"preserved" results when a later trial happened to land on a backend still
carrying an earlier trial's identically-named leftovers. The fix was to
give every trial's objects a fresh, trial-unique name - which is also
exactly what a real application must do if it wants to safely reuse
backend-scoped Postgres objects under transaction pooling at all.

`pnpm scenario:pool-size-tuning` demonstrates that `default_pool_size`
itself is a real tuning knob. Same 40 concurrent clients, same
`pgbouncer-transaction` instance, only `default_pool_size` changed live via
PgBouncer's admin console between runs (`SET default_pool_size = ...`,
followed by `KILL <db>` + `RESUME <db>` so already-open backends from a
previous measurement do not silently inflate the next one - see
`src/db/pgbouncer-admin.ts`):

```text
concurrentClients: 40, querySleepMs: 50
smallPoolSize: 2   -> smallPoolWallClockMs: 1062
largePoolSize: 20  -> largePoolWallClockMs: 199
```

A pool of 2 real backends serialized 40 concurrent clients into roughly 20
sequential rounds; a pool of 20 finished in about one round. Too small a
pool starves concurrent clients behind a handful of backends even though
Postgres has plenty of `max_connections` headroom (30) to support a larger
pool; too large a pool (approaching or exceeding `max_connections`) removes
the entire benefit of pooling in the first place.

## Why the fix works

PgBouncer terminates the client's TCP connection at itself and reuses a
small, bounded set of already-open Postgres backend connections to satisfy
many short-lived client requests. Opening a new *client-to-PgBouncer*
connection is cheap (no new Postgres backend process); handing out an
already-open, already-authenticated Postgres backend connection to satisfy
one transaction is also cheap. The `max_connections` ceiling on the real
Postgres side is only ever touched by `default_pool_size` (plus a small
number of direct connections like migrations, PGweb, and admin tooling),
not by however many application clients happen to be concurrently active.

Migrations and seeding in this lab (`src/db/migrate.ts`, `src/seed/seed.ts`)
deliberately run against `DATABASE_URL` (direct Postgres), never through
`DATABASE_URL_PGBOUNCER_TRANSACTION`. This is a real operational caveat,
not just a convention: a migration runner is one connection doing one job
end to end, not a pool of many short client sessions, so it gets no benefit
from PgBouncer. Worse, DDL and migration tooling can depend on session-
level guarantees (holding an explicit transaction open across many
statements, an advisory lock some migration frameworks take out, `SET
search_path` staying in effect) that transaction pooling does not
guarantee at all - see "Fix it" above for exactly what breaks. PGweb is
likewise pointed directly at Postgres in `docker-compose.yml`, because it
holds a long-lived interactive session doing exactly the kind of
session-state-dependent work (arbitrary ad-hoc queries, potentially temp
tables) that this lab demonstrates breaking under transaction pooling.

## Tradeoffs

- **Session pooling vs transaction pooling**: session pooling preserves
  every session-state guarantee an ordinary direct Postgres connection
  would, at the cost of needing (up to) as many real backend connections as
  concurrent clients - it does not solve the connection-exhaustion problem
  by itself once client concurrency approaches `max_connections`.
  Transaction pooling solves connection exhaustion for short, stateless
  queries but silently breaks anything relying on backend continuity
  between statements.
- **`default_pool_size`**: too small starves concurrent clients behind a
  small number of real backends (measured: 5.3x slower wall-clock time at
  pool size 2 vs 20 for the identical 40-client burst in this lab); too
  large approaches or exceeds Postgres's own `max_connections` and defeats
  the purpose of pooling.
- **PGweb and migrations bypassing PgBouncer entirely**: correct and safe,
  but means the direct-connection budget (Postgres's `max_connections`)
  still has to account for these long-lived direct connections separately
  from whatever PgBouncer's pool consumes.
- **Two PgBouncer instances vs one instance with two database entries**:
  running two full instances is slightly more resource overhead (two
  processes, two ports) in exchange for a config that reads unambiguously
  as "this port is session mode, this port is transaction mode" rather
  than requiring a reader to notice a database-name convention inside one
  `pgbouncer.ini`.

## Production notes

1. **What guarantee does this technique provide?** PgBouncer transaction
   pooling guarantees that Postgres's own connection/backend-process
   overhead scales with `default_pool_size`, not with concurrent client
   count - letting an application safely run far more concurrent logical
   database clients than Postgres's `max_connections` would otherwise
   allow.
2. **What does it not guarantee?** Backend continuity between statements
   issued outside a single explicit transaction. Anything relying on that
   (session GUCs, temp tables, prepared statements, session-level advisory
   locks, `LISTEN`/`NOTIFY`) can silently fail or behave inconsistently.
   It also does not provide read/write routing, load balancing across
   multiple Postgres nodes, or query caching - it pools connections, full
   stop.
3. **What breaks under process crash?** If PgBouncer itself crashes, every
   client connected through it loses its connection and must reconnect;
   in-flight transactions on the Postgres side are rolled back the same as
   any other dropped connection. If Postgres crashes, PgBouncer's existing
   server connections all fail and it must reopen fresh ones once Postgres
   recovers - clients see errors during that window.
4. **What breaks under network partition?** A partition between PgBouncer
   and Postgres behaves like a Postgres outage from the application's
   point of view - PgBouncer cannot serve any query until connectivity (or
   Postgres itself) is restored, since it has no fallback database to
   route to (see "does not do read/write routing" above).
5. **What changes at high contention?** More concurrent clients than
   `default_pool_size` queue inside PgBouncer for a free backend (`SHOW
   CLIENTS` shows `state = waiting`); past `query_wait_timeout` a queued
   client's query fails with a timeout instead of running indefinitely.
   This lab's pool-size-tuning scenario measures the resulting throughput
   cost directly.
6. **What changes with multiple regions?** Not exercised in this lab - a
   real multi-region deployment typically runs a PgBouncer instance local
   to each application region, still pointed at one authoritative Postgres
   primary (see Lab 25+ for replica routing, which is a separate,
   composable concern from pooling).
7. **What metrics would you monitor?** PgBouncer's own `SHOW POOLS` /
   `SHOW STATS` (client wait time, average query time, pool utilization),
   Postgres's `pg_stat_activity` connection count relative to
   `max_connections`, and application-level connection-acquisition latency.
8. **What simpler alternative could be used?** For a single application
   process with modest concurrency, an in-process connection pool (e.g.
   `pg.Pool` sized to a sane maximum) may be enough without adding
   PgBouncer at all - add PgBouncer when the number of *processes* (not
   just connections within one process) needing database access grows
   large relative to `max_connections`.
9. **When should you avoid this technique?** Avoid transaction pooling for
   any connection that needs multi-statement session state (migration
   runners, admin tooling, `LISTEN`/`NOTIFY` subscribers, code using
   session-level advisory locks or server-side cursors held across
   statements) - use a direct connection or session pooling for those
   instead.

## Interview questions

1. Why does Postgres reject the 31st connection outright instead of
   queuing it, and why is that the correct default behavior for a
   database?
2. What specifically does PgBouncer's `default_pool_size` bound, and what
   does it not bound?
3. Why does `SET application_name = ...` behave differently from `SET
   myapp.session_marker = ...` under transaction pooling?
4. Why should a migration runner never go through a transaction-pooling
   PgBouncer instance?
5. If a temp table created by one client mysteriously already exists for a
   different, unrelated client under transaction pooling, what does that
   tell you about PgBouncer's default reset behavior?
6. Why can't PgBouncer perform read/write routing to a primary and a
   replica by itself?
7. What would you expect to observe in `pg_stat_activity` if
   `default_pool_size` were set higher than Postgres's own
   `max_connections`?

## Further experiments

- Lower `default_pool_size` on `pgbouncer-transaction` to 1 and rerun
  `pnpm scenario:session-vs-transaction` with `noiseClients=0` - does the
  session-state marker survive more often now, and why?
- Add a fourth PgBouncer instance with `POOL_MODE=statement` (PgBouncer's
  most aggressive mode, one server connection per statement, not even per
  transaction) and compare its behavior against transaction mode.
- Use `SHOW STATS` on the transaction-pooling instance's admin console
  after a scenario run and look at `avg_wait_time`/`avg_query_time`.
- Try `pg_advisory_lock` through the transaction-pooling instance across
  two statements and see it silently fail to protect anything, the same
  way Lab 13 shows an unrelated connection can freely update a row an
  advisory lock is "protecting."
- Reconfigure `POSTGRES_MAX_CONNECTIONS` back up to Postgres's real default
  of 100 and rerun the direct-overload scenario with a proportionally
  larger `SCENARIO_CONNECTIONS` (120-150) to see the same failure at
  Postgres's actual out-of-the-box ceiling.
