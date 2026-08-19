# Lab 39 - Row-Level Security and Database Security

## Why this exists

Almost every real multi-tenant SaaS product uses the same shared-schema
model this lab does: one `tenants` table, one `support_tickets` table, every
tenant's rows sitting side by side in the exact same physical table,
distinguished only by a `tenant_id` column. The entire safety of that model,
in a huge number of real production codebases, rests on every single query
against that table remembering to add `WHERE tenant_id = ?`. That is an
application-code convention, not a database-enforced guarantee - and
application code has bugs. An admin/debug endpoint that lists tickets across
an internal support queue. A newly added search endpoint. A background
digest job. A copy-pasted query missing one clause. Any one of these, for as
long as it goes unnoticed, hands one tenant's private data to another
tenant's session.

This lab reproduces that leak for real, against a real Postgres connection,
with a real over-fetching query and real leaked rows - not a hypothetical.
It then fixes it the way CLAUDE.md's "Security" section requires: real,
distinct, least-privilege Postgres roles (an application role, a migration
role, a read-only reporting role - none of them superuser), and real
`ROW LEVEL SECURITY` policies that enforce tenant isolation **in the
database**, keyed off a session-level `app.current_tenant_id` setting -
the standard real-world pattern for connection-pooled multi-tenant RLS. The
same buggy query is then replayed, byte-for-byte identical, against the
RLS-protected table, and returns zero rows from any other tenant -
regardless of what the application's own `WHERE` clause does or doesn't say.

Finally, this lab demonstrates the real, common RLS misconfiguration every
team hits at least once: RLS policies do **not** apply to the table's owner,
and **never** apply to a superuser or a `BYPASSRLS` role, no matter what the
policy says. That single fact is why "who owns this table" is itself a
security decision.

## Learning objectives

After this lab you should be able to:

- explain the shared-schema/shared-table multi-tenancy model and why
  `tenant_id`-based isolation must be enforced in the database, not only in
  application code;
- reproduce a real cross-tenant data leak caused by (a) a forgotten
  `WHERE tenant_id = ?` clause and (b) a `WHERE` clause with a correctly
  present but *wrong* tenant id, and explain why these are two genuinely
  different bug classes;
- create least-privilege Postgres roles (migration/application/read-only)
  and produce real, captured `SQLSTATE 42501` errors when each role attempts
  an operation outside its grant;
- write `CREATE POLICY` statements keyed off `current_setting('app.xxx')`
  and explain why `missing_ok=true` plus `nullif(..., '')` makes the policy
  fail CLOSED (deny) rather than error when a session forgot to set its
  tenant context;
- explain precisely why RLS does not protect data from the table owner or
  from a `BYPASSRLS`/superuser role, and why that means "who owns this
  table" is a security decision, not an implementation detail;
- explain, with real measured numbers, why an indexed equality policy
  predicate costs close to nothing extra, and why a policy predicate that
  requires a subquery or join per row would not.

## Architecture

```text
tenants          (id, public_id, name, slug, created_at)
support_tickets  (id, public_id, tenant_id -> tenants.id, subject, body, status, created_at)
```

A fresh, independent multi-tenant SaaS-style domain - a support-ticketing
helpdesk - not one of SPEC.md 8.2's five named domains
(payroll/ticketing/commerce/banking/background-processing). A helpdesk is a
believable place for exactly the kind of leak this lab demonstrates: an
internal admin/debug view, a cross-tenant search box, or a digest job are
all realistic places a `WHERE tenant_id = ?` clause gets dropped or
miscomputed by accident. Multi-tenancy model: **shared schema, shared
tables, a `tenant_id` column** - the realistic model most real SaaS products
actually use, not schema-per-tenant or database-per-tenant.

**Four real Postgres roles, not one** (every other lab in this repo connects
as a single superuser - this lab is deliberately the exception):

| Role | Attributes | Used for |
|---|---|---|
| `lab39_admin` | `SUPERUSER`, `BYPASSRLS` (Postgres's own docker-bootstrap superuser) | Creating the other three roles ONCE at container init. Never used by the app or by migrations. |
| `lab39_migrator` | `NOSUPERUSER`, `NOBYPASSRLS`, `CREATE` on schema `public` and the database | Runs `pnpm db:migrate`. Owns every table/function/policy it creates - which is exactly why it silently bypasses RLS (see "Break it"). |
| `lab39_app` | `NOSUPERUSER`, `NOBYPASSRLS`, `SELECT/INSERT/UPDATE/DELETE` on data tables only | The application server's day-to-day connection. Subject to RLS like any non-owner role. |
| `lab39_readonly` | `NOSUPERUSER`, `NOBYPASSRLS`, `SELECT` only | A reporting/BI connection (also PGweb's connection - see "Setup"). Subject to RLS like `lab39_app`. |

**Bootstrapping order** (the real chicken-and-egg concern - see `sql/000-bootstrap-roles.sql`):
a migration or application role must never be granted `CREATEROLE` (that
alone would let it mint a superuser and defeat every other privilege
boundary in this lab), so *something* with admin rights has to exist first
to create the other three roles. Here that's Postgres's own
docker-entrypoint-initdb.d mechanism, running once as the
`lab39_admin` superuser the first time the data volume is initialized -
standing in for a real cloud provider's "master user" (RDS/Cloud SQL).
`docker compose down -v` removes that volume, so `up -d` genuinely re-runs
the bootstrap script and recreates every role from scratch - exercised
directly in this lab's own reset-cycle validation.

```text
docker compose up -d                              (fresh volume)
  -> Postgres runs sql/000-bootstrap-roles.sql AS lab39_admin (superuser)
     creates lab39_migrator / lab39_app / lab39_readonly
     grants CREATE on schema public + database to lab39_migrator only
     sets ALTER DEFAULT PRIVILEGES so future migrator-created tables
       auto-grant the right baseline privileges to app/readonly
pnpm db:migrate                                    (AS lab39_migrator)
  -> 0000_*.sql   creates tenants/support_tickets (migrator becomes OWNER)
  -> 0001_*.sql   creates current_tenant_id(), enables RLS, creates
                  policies, re-grants explicitly (belt and suspenders)
pnpm seed                                           (AS lab39_migrator - the
                                                      one legitimate bypass:
                                                      writing every tenant's
                                                      rows in one script)
```

Five scenario scripts, one shared "identical buggy query" module so the
naive and fixed scenarios provably run the exact same SQL:

```text
src/scenarios/buggy-queries.ts       <- the two buggy queries, shared verbatim
src/scenarios/naive-leak.ts          <- THE BUG: real leak, RLS off
src/scenarios/rls-fix.ts             <- THE FIX: identical queries, RLS on
src/scenarios/least-privilege.ts     <- real 42501s per role
src/scenarios/owner-bypass.ts        <- the owner/superuser bypass gotcha
src/scenarios/performance.ts         <- real EXPLAIN ANALYZE timing/buffers
```

## Setup

```bash
pnpm install
cp labs/39-row-level-security-and-db-security/.env.example labs/39-row-level-security-and-db-security/.env
cd labs/39-row-level-security-and-db-security
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate
pnpm seed          # --seed=42 --size=medium by default: 40 tenants, 100,000 tickets
```

Open PGweb at http://localhost:8439. It connects as `lab39_readonly` (not
the admin or migrator role) - a deliberate choice: PGweb is a
browser-exposed inspection tool, and per this lab's own least-privilege
lesson it should hold the smallest privilege that lets a human browse the
schema. Because `lab39_readonly` is subject to RLS like any other non-owner
role, and PGweb's own connection never calls `set_config('app.current_tenant_id', ...)`,
**you will see zero rows in `support_tickets` through PGweb** - that is RLS
correctly failing closed for a connection with no tenant context, not a
bug. Use `psql`/the scenario scripts to see rows as a specific tenant.

## Scenario

Acme (tenant A) and Globex (tenant B) are two unrelated customers of the
same support-ticketing SaaS product. Both tenants' tickets live in the same
`support_tickets` table. An engineer builds an internal admin dashboard
endpoint - "list recent tickets" - and forgets the tenant filter every other
endpoint in the codebase has. Separately, a different engineer builds a
"switch active tenant" feature and introduces a bug where the wrong tenant id
ends up in a otherwise-correctly-shaped query.

## Prediction

Before running anything, predict:

1. With no database-level enforcement, what does a `SELECT * FROM support_tickets`
   with no `WHERE` clause return, run by the application's own
   database role, for a request that is supposed to be scoped to tenant A?
2. If a `WHERE tenant_id = ?` clause is present but the value plugged into
   it is tenant B's id (not tenant A's), and Row-Level Security is enabled
   with the session correctly set to tenant A, what comes back - tenant B's
   rows, an error, or nothing?
3. Does the role that owns `support_tickets` (the migration role) see other
   tenants' rows once RLS is enabled, even if it never sets
   `app.current_tenant_id` at all?
4. Does adding an RLS policy on an already-indexed `tenant_id` column make
   an equality-filtered query meaningfully slower?

## Exercise

1. Run the setup commands above.
2. Reproduce the real leak:
   ```bash
   pnpm scenario:naive-leak
   ```
3. Prove the fix blocks the identical queries:
   ```bash
   pnpm scenario:rls-fix
   ```
4. Prove each role's least-privilege boundary with real captured errors:
   ```bash
   pnpm scenario:least-privilege
   ```
5. Prove the owner/superuser bypass gotcha:
   ```bash
   pnpm scenario:owner-bypass
   ```
6. Measure the real performance cost of the policy predicate:
   ```bash
   pnpm scenario:performance
   ```
7. Run `pnpm test` and read through `tests/integration/*.test.ts` - these
   assert the exact invariants above as real, automated, repeatable checks.

## Observe

- **PGweb** (http://localhost:8439, connected as `lab39_readonly`): zero
  rows visible in `support_tickets` with no tenant session set - see
  "Setup" for why that's correct, not broken.
- **`docker exec lab39-postgres psql -U lab39_admin -d lab39 -c "\dp support_tickets"`**:
  real `GRANT` state per role (`lab39_app=arwd`, `lab39_readonly=r`,
  `lab39_migrator=arwdDxt` as owner) and the `tenant_isolation` policy text.
- **`docker exec lab39-postgres psql -U lab39_admin -d lab39 -c "\du"`**:
  real role attributes (`Superuser`/`Bypass RLS` present only on
  `lab39_admin`).
- **Structured logs**: every scenario logs through `@labs/logging` (Pino)
  with real row counts, tenant ids, and captured SQLSTATEs on every step.
- **`docker compose logs postgres`**: `log_statement=all` shows exactly
  which role ran which statement, in order.

## Break it

Run:

```bash
pnpm scenario:naive-leak
```

Real captured output from this lab's own validation run, immediately after
a fresh `docker compose down -v && up -d` -> `pnpm db:migrate` -> `pnpm seed`
(40 seeded tenants, 100,000 seeded tickets, 2,500 per tenant - tenant A/B's
actual numeric ids depend on how many times `pnpm seed` has run since the
last full reset, since `DELETE` does not reset the identity sequence; a
fresh reset gives them ids 1/2, as below):

```text
control query (correctly filtered) - looks fine, this is what most endpoints do correctly
  tenantId: 1   rows: 2500

REAL LEAK (bug #1, forgotten WHERE clause): a request scoped to one tenant
received rows belonging to every tenant in the table
  requestingTenant: "Scenario Tenant - Acme (A)"
  totalRowsReturned: 100000
  distinctTenantIdsReturned: 40
  rowsBelongingToOtherTenants: 97500
  sampleLeakedRow: { id: 27107, tenant_id: 11, subject: "Carcer necessitatibus culpa sonitus." }

REAL LEAK (bug #2, wrong tenant id computed): a request FOR tenant A
received tenant B's rows because the WHERE clause's value, not its
presence, was the bug
  requestingTenant: "Scenario Tenant - Acme (A)"
  queriedTenantId: 2   queriedTenantName: "Scenario Tenant - Globex (B)"
  rowsReturned: 2500
```

This is a real leak against a real Postgres connection: the `lab39_app`
role, Row-Level Security temporarily disabled (`ALTER TABLE support_tickets
DISABLE ROW LEVEL SECURITY`, run only by the owning migrator role), with no
database-level enforcement at all. Bug #1's single missing clause handed a
request "for tenant A" every one of the other 39 tenants' 97,500 rows. Bug
#2's WHERE clause was present and syntactically fine - it just named the
wrong tenant - and returned exactly and only tenant B's real 2,500 rows to a
tenant A request. The script always re-enables RLS in a `finally` block
before exiting, so the database is never left insecure by running this demo.

## Fix it

Run:

```bash
pnpm scenario:rls-fix
```

Real captured output - the **identical** two buggy queries from
`buggy-queries.ts`, replayed unmodified against the same table, same `app`
role, with RLS enabled:

```text
bug #1 replayed under RLS: the exact same tenant-blind query now returns
ONLY the calling tenant's own rows
  requestingTenant: "Scenario Tenant - Acme (A)"   sessionTenantId: 1
  totalRowsReturned: 2500   distinctTenantIdsReturned: 1   rowsBelongingToOtherTenants: 0

bug #2 replayed under RLS: the app's own WHERE clause asked for tenant B,
but the session's RLS predicate is ANDed onto it - zero rows, not tenant B's data
  requestingTenant: "Scenario Tenant - Acme (A)"   sessionTenantId: 1
  queriedTenantId: 2   queriedTenantName: "Scenario Tenant - Globex (B)"
  rowsReturned: 0

no app.current_tenant_id set at all: RLS's default-deny means zero rows,
not every tenant's rows
  rowsReturned: 0
```

Neither buggy query was fixed. The forgotten `WHERE` clause is still
missing in bug #1's query; the wrong tenant id is still hardcoded into bug
#2's query. The only thing that changed between "Break it" and "Fix it" is
that `ROW LEVEL SECURITY` is enabled on `support_tickets` with a
`tenant_isolation` policy - and that alone is what turned a 97,500-row leak
into zero rows, and a specific-other-tenant leak into zero rows. A session
with no tenant context at all also gets zero rows, not every tenant's data
- RLS fails CLOSED.

### The owner/superuser bypass gotcha

Run:

```bash
pnpm scenario:owner-bypass
```

Real captured output:

```text
role attributes and table ownership
  roles: [
    { rolname: "lab39_admin",     rolsuper: true,  rolbypassrls: true  },
    { rolname: "lab39_app",       rolsuper: false, rolbypassrls: false },
    { rolname: "lab39_migrator",  rolsuper: false, rolbypassrls: false },
    { rolname: "lab39_readonly",  rolsuper: false, rolbypassrls: false }
  ]
  tableOwner: "lab39_migrator"

OWNER BYPASS: the owning role sees every tenant's rows even with RLS
enabled and no FORCE ROW LEVEL SECURITY set, and even with no tenant
session context
  role: "lab39_migrator (table owner, NOT superuser, NOT BYPASSRLS)"
  total: 100000   distinct_tenants: 40

SUPERUSER BYPASS: a superuser connection ignores RLS unconditionally - this
would be true even if FORCE ROW LEVEL SECURITY were set on the table
  role: "lab39_admin (superuser)"
  total: 100000   distinct_tenants: 40

ENFORCED: the app role, with no tenant context set, sees zero rows - the
SAME identical query the owner/superuser just ran against every tenant's data
  role: "lab39_app (not owner, not BYPASSRLS)"
  total: 0   distinct_tenants: 0
```

`lab39_migrator` is not a superuser and does not have `BYPASSRLS` - it
bypasses RLS purely because it OWNS `support_tickets` (it created the table
in migration 0000), and this lab's migration 0001 deliberately does **not**
set `ALTER TABLE ... FORCE ROW LEVEL SECURITY`. This is the real, common
misconfiguration: many teams enable RLS, write a correct policy, and never
realize the migration/deploy role that owns the table - which is very often
also the role a human uses interactively for one-off fixes - was never
subject to the policy at all. `lab39_admin`'s bypass is the more obvious
one (superusers and `BYPASSRLS` roles always ignore RLS, `FORCE` or not),
but it's the OWNER bypass that catches teams off guard, because nothing
about it looks like an elevated privilege in everyday use.

## Why the fix works

`ROW LEVEL SECURITY`, once enabled with a policy, is applied by Postgres as
an implicit `AND` onto every query's own `WHERE`/`INSERT ... VALUES`/`UPDATE
... SET` against that table, for every role that is not the table's owner
and does not have `BYPASSRLS` - **regardless of what the application's own
query does or doesn't filter on**. That is precisely why bug #1 (missing
filter) and bug #2 (wrong filter value) are both blocked by the same
mechanism: the database adds its own condition on top of whatever the
application asked for, every single time, with no way for a buggy query to
opt out. `current_tenant_id()`'s `current_setting(..., true)` plus
`nullif(..., '')` makes an unset session fail CLOSED (see zero rows) rather
than raising an error or, worse, matching every row via a NULL comparison
that silently evaluates to unknown/false anyway - the correct default for a
security boundary.

Least privilege is the second, independent layer: even if a bug somehow
bypassed RLS logic in application code (impossible for RLS itself, but not
for, say, a raw admin connection reused somewhere it shouldn't be), the
`lab39_app` role still cannot run DDL, cannot drop or alter the table, and
the `lab39_readonly` role cannot write at all - narrowing the blast radius
of any other class of compromise or bug to exactly the grant each role
actually needs.

## Tradeoffs

- **RLS is defense-in-depth, not a replacement for correct application
  logic.** A tenant-blind query is still a bug worth fixing - RLS makes it a
  non-incident instead of a breach, but the application code that forgot
  the filter is still wasting a full table scan's worth of rows fetched
  from the database (even if the visible RESULT is filtered to zero, in
  some plan shapes Postgres still has to evaluate the policy predicate per
  candidate row) and is still a maintenance smell worth fixing.
- **Ownership is a security decision, not an implementation detail.** The
  role that owns a Row-Level-Security-protected table has an unconditional
  bypass unless `FORCE ROW LEVEL SECURITY` is also set - and even then, a
  superuser or `BYPASSRLS` role bypasses regardless. In production, the
  role that owns these tables should be a narrow, audited migration
  role - never the everyday application role, and never a role humans
  routinely log in as interactively for ad-hoc queries.
- **Performance cost is real but was measured small here, and that result
  is specific to this policy's shape, not universal** - see
  `pnpm scenario:performance`'s real numbers below. A policy predicate that
  requires a join or correlated subquery per row (e.g. `tenant_id IN (SELECT
  tenant_id FROM memberships WHERE user_id = current_user_id())`, a common
  real-world "which tenants can this user see" pattern) is NOT index-only
  in the way this lab's simple equality predicate is, and its cost scales
  with table size in a way a single indexed column comparison does not.
- **`SET`/`set_config` session state under connection pooling is a real
  operational hazard.** `src/db/roles.ts`'s `withTenantSession` always
  resets `app.current_tenant_id` back to `''` before releasing a connection
  - skip that reset (e.g. a connection that errors out mid-transaction and
  gets released without it running) and the NEXT logical request to reuse
  that physical connection inherits the PREVIOUS tenant's session context
  until it explicitly sets its own. This is the same class of caveat Lab
  23 raises for PgBouncer session-pooled prepared statements, applied to an
  RLS session variable instead.

Real measured performance (`pnpm scenario:performance`, median of 5 runs
per invocation, 100,000 seeded rows, `support_tickets_tenant_id_idx`
present, `EXPLAIN (ANALYZE, BUFFERS)`), across several separate runs of
this lab's own validation:

```text
withRlsMedianMs:    0.215 - 0.933  (across repeated invocations)
withoutRlsMedianMs: 0.197 - 0.267
withRlsBuffers:     89-90          withoutRlsBuffers: 89-90   (always equal, same invocation)
```

The **buffer/I-O cost is identical within every single invocation** (the
RLS-on and RLS-off halves of the same run always report the same shared-hit
block count) - Postgres's planner recognizes `tenant_id = $1 AND tenant_id =
current_tenant_id()` as two equality conditions on the same column and
folds them into a single `Index Cond: tenant_id = $1` plus a `One-Time
Filter` (evaluated once per statement, not once per row, because
`current_tenant_id()` is declared `STABLE`) rather than a full second scan.
Wall-clock time with RLS on was consistently higher than without across
every run, but noisier in absolute terms (sub-millisecond either way, on a
shared laptop-class Docker container - not a number to treat as a
production SLO) - the honest takeaway is "a small, roughly constant,
sub-millisecond function-call evaluation cost (`current_setting` + `nullif`
+ a cast), not a cost that scales with row count for THIS policy's shape,"
not a precise fixed millisecond figure. See "Tradeoffs" above for why a
join/subquery-based policy would not get this same index folding, and
"Further experiments" for re-running this at `--size=large` to confirm the
gap does not grow with table size.

## Production notes

1. **What guarantee does this mechanism give?** Row-Level Security
   guarantees that a query issued by a role that is neither the table owner
   nor `BYPASSRLS` can never read or write a row that fails the active
   policy's predicate, regardless of what that query's own `WHERE`/`SET`
   clauses do or don't specify. Least-privilege roles guarantee that a
   given database credential can only perform the specific operations
   (SELECT/INSERT/UPDATE/DELETE/DDL) it was explicitly granted.
2. **What does it not guarantee?** RLS does not protect against a
   correctly-authorized write that is simply wrong in a way the policy
   can't see (e.g. the right tenant, wrong customer record). It does not
   protect against the owning role or a `BYPASSRLS`/superuser connection at
   all. It does not make an inefficient or buggy query efficient or
   correct - only tenant-safe.
3. **What failure mode remains?** A connection pool that reuses a physical
   connection without resetting `app.current_tenant_id` between logical
   requests (see "Tradeoffs"); an application bug that connects as
   `lab39_migrator`/`lab39_admin` for ordinary request handling instead of
   `lab39_app` (an easy mistake if credentials are managed loosely), which
   silently reintroduces the exact leak this lab exists to close; a
   forgotten `ENABLE ROW LEVEL SECURITY` on a newly added tenant-scoped
   table in a future migration.
4. **How does contention affect it?** RLS policy evaluation participates in
   the same MVCC/locking model as any other query - it does not add new
   lock types or contention beyond whatever the underlying query already
   does.
5. **What changes at larger scale?** An indexed equality policy predicate
   (this lab's shape) stays cheap as the table grows, because it's folded
   into the same index scan a hand-written `WHERE` clause would use. A
   join/subquery-based policy (e.g. membership-table lookups) gets
   proportionally more expensive as the referenced table grows, and is a
   real candidate for its own index or a materialized/cached tenant lookup.
6. **What metrics would be monitored?** `pg_stat_user_tables`/`pg_stat_statements`
   for the tenant-scoped tables (to catch a policy predicate that stopped
   using an index after a schema change), failed-login/permission-denied
   rates per role (a spike in `42501`s from the `app` role is a strong
   signal of an application bug, not noise to suppress), and an explicit
   alert on any query connecting as `lab39_migrator`/`lab39_admin` outside
   of a deploy window.
7. **When should this approach be avoided?** RLS adds real (if small, for
   simple predicates) per-query overhead and real operational complexity
   (session-state hygiene under pooling, policy maintenance alongside
   schema changes) - for a single-tenant system, or a system where tenant
   isolation is already enforced by physically separate
   databases/schemas per tenant, adding RLS on top would be unnecessary
   defense-in-depth for a threat model that doesn't apply.

## Interview questions

1. Why does a forgotten `WHERE tenant_id = ?` clause leak ALL tenants'
   data, while a `WHERE tenant_id = <wrong id>` clause leaks exactly ONE
   other tenant's data - and why does the same RLS policy block both?
2. Why does `current_setting('app.current_tenant_id', true)` combined with
   `nullif(..., '')` matter for failing CLOSED instead of erroring or
   silently matching everything?
3. Why doesn't Row-Level Security protect data from the role that owns the
   table, even without `BYPASSRLS`? What would `FORCE ROW LEVEL SECURITY`
   change, and what would it still not change?
4. Why should the migration role and the application role never be the same
   Postgres role, even though both eventually touch the same tables?
5. Given a `tenant_id IN (SELECT tenant_id FROM memberships WHERE user_id =
   current_user_id())` policy instead of this lab's plain equality, why
   would you expect its performance to scale differently as the table
   grows?
6. Under PgBouncer transaction pooling (Lab 23), what real hazard does a
   `SET`-based session variable like `app.current_tenant_id` introduce that
   a plain `WHERE` clause parameter does not?

## Further experiments

- Add `ALTER TABLE support_tickets FORCE ROW LEVEL SECURITY;` and re-run
  `scenario:owner-bypass` - confirm `lab39_migrator`'s bypass disappears
  while `lab39_admin`'s (superuser) does not, proving `FORCE` closes the
  owner gap but can never close the superuser/`BYPASSRLS` one.
- Add a third, deliberately more expensive policy on a copy of
  `support_tickets` keyed off a join against a small `memberships` table
  instead of a plain column equality, and re-run `scenario:performance`
  against it to measure how much the "not index-only" cost this README
  describes actually is at this lab's row counts.
- Seed `--size=large` (100 tenants, 5,000 tickets each = 500,000 rows) and
  re-run `scenario:performance` - confirm the RLS-on/RLS-off gap stays a
  small, roughly constant number of milliseconds rather than growing with
  table size, for this lab's indexed-equality policy shape.
- Modify `withTenantSession` to skip the `finally` reset once, on purpose,
  and observe the next caller on a reused pooled connection inherit the
  previous tenant's session context - the real hazard "Tradeoffs" and
  "Production notes" describe, made concrete.
- Add a second tenant-scoped table (e.g. `attachments`, tenant_id FK to
  `support_tickets`) and write its own `tenant_isolation` policy - notice
  every tenant-scoped table needs its OWN `ENABLE ROW LEVEL SECURITY` and
  `CREATE POLICY`; RLS does not cascade through foreign keys.
