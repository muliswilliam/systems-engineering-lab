# Lab 02 - Relational Modeling and Constraints

## Why this exists

Lab 01's schema was already correct - a real foreign key, real unique
constraints, an idempotent seed. This lab exists to show what happens when
those constraints are missing, because in a real codebase they go missing
all the time: a migration written in a hurry, a "temporary" table that
becomes permanent, a raw `psql` session during an incident, an ORM model
that only validates in application code. If the invariant is not enforced by
Postgres, something will eventually violate it. This lab makes that failure
happen on purpose, then fixes it with `NOT NULL`, foreign keys, `UNIQUE`,
and `CHECK` - and shows you exactly which Postgres error class fires for
each one.

## Learning objectives

After this lab you should be able to:

- explain why an entity often carries both an internal `bigint` id and a
  public `uuid`, and when a "natural" key like `email` is not a good
  candidate for either role;
- read a Postgres constraint violation and identify which SQLSTATE error
  class produced it (`23502`, `23503`, `23505`, `23514`);
- explain the difference between a `CHECK` constraint (restricts the set of
  legal values for one row) and a state-transition rule (restricts which
  value changes are legal given the row's previous value) - and why the
  former cannot enforce the latter;
- point to the exact Postgres DDL that creates each of `NOT NULL`, a foreign
  key, a `UNIQUE` constraint, and a `CHECK` constraint, both by reading a
  Drizzle migration and by reading raw SQL.

## Architecture

```text
┌──────────────────┐                    ┌───────────────────┐
│ naive-inserts.ts │──raw SQL, no FK───▶│ naive_companies /  │
│ (scenario:naive) │◀──always succeeds──│ naive_employees    │
└──────────────────┘                    └───────────────────┘
                                                  ▲
                                     same Postgres instance
                                                  ▼
┌───────────────────┐              ┌───────────────────────────┐
│ corrected-        │──insert/UPDATE│ companies / employees     │◀── pgweb
│ inserts.ts         │─────────────▶│ (FK, UNIQUE, CHECK,       │    (browser UI)
│ (scenario:fixed)   │◀──rejected───│  NOT NULL - real schema)  │
└───────────────────┘   w/ pg code  └───────────────────────────┘
                                                  ▲
                                            seed.ts / tests
```

Domain: the same **payroll** slice as Lab 01 (companies, employees), with one
addition - `employees.employment_status`, used to teach `CHECK` and its
limits. The naive tables live in the same database as the real schema
(different table names, `naive_*`), so both scenario scripts run against a
single `docker compose up -d` stack with no extra services.

## Setup

```bash
pnpm install
cp labs/02-relational-modeling-and-constraints/.env.example labs/02-relational-modeling-and-constraints/.env
cd labs/02-relational-modeling-and-constraints
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate
pnpm seed
```

Open PGweb at http://localhost:8402 (it auto-connects via
`PGWEB_DATABASE_URL`). You should see `companies` and `employees` populated,
with a mix of `employment_status = 'active'` and `'terminated'` rows.

## Scenario

A payroll company has employees. Each employee has a salary, an employment
status, and belongs to exactly one company. Several things must always be
true no matter what inserts or updates a script, a migration, or a bug
attempts:

- every employee's `company_id` must point at a company that actually exists;
- every `public_id` must be globally unique (it's handed out in API
  responses and URLs - a collision would let one tenant's link resolve to
  another tenant's row);
- every employee's email must be unique;
- salaries must be positive;
- `employment_status` must be one of a known, finite set of values.

## Prediction

Before running anything, predict:

1. If a table has no foreign key from `employees.company_id` to
   `companies.id`, what happens when you insert an employee with a
   `company_id` of `999999999` - does Postgres reject it, silently accept
   it, or accept it with a warning?
2. Once the real foreign key, unique constraints, and `CHECK` constraints
   exist, do a negative salary and a duplicate `public_id` fail with the
   *same* Postgres error code, or different ones?
3. If `employment_status` is restricted by `CHECK (employment_status IN
   ('active', 'terminated'))`, can an employee ever go from `'terminated'`
   back to `'active'`? Will the `CHECK` constraint stop it?

## Exercise

1. Run the setup commands above.
2. Run `pnpm scenario:naive` and read the log output - every attempted bad
   insert against the naive tables (no FK, no unique `public_id`, no
   `CHECK`) succeeds.
3. Open PGweb and look at `naive_companies` / `naive_employees` - the ghost
   employee, the duplicate `public_id`, the negative salary, and the
   nonsense `employment_status` are all sitting there as real rows.
4. Run `pnpm scenario:fixed` and read the log output - the same four
   categories of bad insert are rejected against the real `companies` /
   `employees` tables, each with a specific `postgresErrorCode`.
5. Look at the last two log lines from `scenario:fixed`: an employee is
   hired as `'terminated'`, and then successfully reactivated back to
   `'active'` - the `CHECK` constraint does not stop this. Answer prediction
   #3 for real.
6. Open `drizzle/0000_*.sql` and find the `CONSTRAINT ... CHECK (...)` and
   `CONSTRAINT ... FOREIGN KEY ...` clauses Drizzle generated from
   `src/db/schema.ts`.

## Observe

- **PGweb** (http://localhost:8402): browse `naive_companies` /
  `naive_employees` after `scenario:naive`, and `companies` / `employees`
  after `seed`. Compare the constraint list under each table's "Structure"
  tab.
- **`docker compose logs postgres`**: the raw `INSERT`/`UPDATE` statements
  and, for the corrected schema, the `ERROR:` lines Postgres logs when it
  rejects a statement.
- **`psql "$DATABASE_URL" -c '\d employees'`**: the real `CHECK`, `UNIQUE`,
  `NOT NULL`, and `FOREIGN KEY` clauses attached to the table.
- **Structured logs**: `pnpm scenario:naive` and `pnpm scenario:fixed` log
  through `@labs/logging` (Pino) with a `postgresErrorCode`/`succeeded`
  field per attempt, so you can see which constraint fired without parsing
  a stack trace.

## Break it

Run the naive scenario and inspect what it left behind:

```bash
pnpm scenario:naive
psql "$DATABASE_URL" -c "SELECT * FROM naive_employees;"
```

You should see an employee with `company_id = 999999999` (no company with
that id exists), two companies sharing the same `public_id`, an employee
with a negative `annual_salary_cents`, and an employee with
`employment_status = 'quantum_superposition'`. None of this was rejected,
because `naive_companies` / `naive_employees` (created by
`src/scenarios/naive-inserts.ts` with raw SQL) were built without a foreign
key, without a unique constraint on `public_id`, and without any `CHECK`.

## Fix it

Run the corrected scenario against the real, migration-managed schema:

```bash
pnpm scenario:fixed
```

Every one of the same four bad inserts is now rejected, and the log line for
each attempt includes the exact Postgres error code:

| Attempt | Constraint | Error code |
|---|---|---|
| employee references a nonexistent company | foreign key | `23503` |
| second company reuses a `public_id` | unique constraint | `23505` |
| second employee reuses an email | unique constraint | `23505` |
| negative salary | check constraint | `23514` |
| invalid `employment_status` | check constraint | `23514` |
| missing `full_name` | not-null constraint | `23502` |

The last two log lines show the boundary of what `CHECK` can do: hiring an
employee as `'terminated'` succeeds, and then updating that same employee's
`employment_status` back to `'active'` *also* succeeds. `'active'` is a
member of the allowed set, so the `CHECK` constraint has nothing to object
to - it cannot see that the row used to say `'terminated'`.

## Why the fix works

Every one of these constraints is enforced by Postgres at the moment a
statement executes, inside the same transaction as the statement itself -
not by application code that has to remember to check first. That is why a
raw `psql` `INSERT`, a bug in an unrelated service, or a future script that
forgets validation all still get rejected: the invariant lives in the
schema, not in any one code path (`docs/architecture-principles.md`).

`CHECK`, however, is a *single-row, value-set* guarantee. It evaluates the
new row (or new column values, on `UPDATE`) in isolation and has no way to
compare against the row's previous state. Preventing `terminated -> active`
specifically (as opposed to merely restricting the *set* of legal statuses)
requires something with memory of the prior value: a trigger comparing
`OLD.employment_status` to `NEW.employment_status`, or an
application/state-machine layer that loads the current row before deciding
whether a transition is legal. Building that state machine properly is
Lab 12's job, not this one - this lab's job is to make the gap visible.

## Tradeoffs

- **Natural vs surrogate keys**: `email` looks like a natural key candidate
  for `employees` - it is meaningful, and in practice unique. But email
  addresses change (typos get corrected, people change providers, companies
  rebrand domains), and they are not good values to embed in URLs or use as
  join keys across other tables added later. This lab still enforces
  `email` uniqueness as a business rule, but `id` (internal joins) and
  `public_id` (external references) remain the actual keys other things
  point at - a natural key can be a *unique constraint* without being the
  *primary* or *public* identifier.
- **`CHECK` vs a trigger vs application logic**: `CHECK` is cheap, always
  enforced regardless of which code path writes the row, and requires no
  extra round-trip. It cannot encode "value X is fine, but not immediately
  after value Y" - that needs a trigger (still datastore-native, but more
  code and harder to reason about at a glance) or application logic (easy to
  bypass from `psql` or a script, per CLAUDE.md's core principle #3: prefer
  datastore-native guarantees, but recognize their limits honestly).
- **bigint identity vs uuid primary key**: this lab keeps the Lab 01 choice
  of a `bigint` primary key plus a `uuid` `public_id` column, rather than
  making `uuid` the primary key. Sequential bigints are smaller, faster to
  index, and better for join performance; random UUIDs as a primary key
  fragment the b-tree on insert. The cost is one extra unique column and
  index per table.
- **Two tables in one database vs a naive migration**: this lab creates the
  naive schema as separate `naive_*` tables via raw SQL instead of an
  earlier "naive" Drizzle migration that a later migration tightens. That
  keeps `src/db/schema.ts` and `drizzle/` representing only the schema you
  should actually build on, at the cost of the naive and corrected tables
  technically coexisting in one database (never confuse them: the naive
  ones are dropped and recreated by `pnpm scenario:naive` every run).

## Production notes

1. **What guarantee does this technique provide?** Postgres refuses to
   commit a row that violates a `NOT NULL`, foreign key, `UNIQUE`, or
   `CHECK` constraint - so those four invariants hold regardless of which
   application, script, or person wrote the row.
2. **What does it not guarantee?** `CHECK` constraints cannot enforce
   invariants that depend on more than the row being written (a previous
   value, another row, an external system). They also cannot be
   *conditionally* enforced per environment without `NOT VALID` /
   `VALIDATE CONSTRAINT` staging (see Lab 29 for adding constraints safely
   to a large, already-populated table).
3. **What breaks under process crash?** Nothing - a crash mid-`scenario:fixed`
   run leaves only the rows that already committed; rerunning is safe
   because both scenario scripts clean up their own marker rows first.
4. **What breaks under network partition?** Not applicable - single
   Postgres node, no replicas yet (see Lab 24+).
5. **What changes at high contention?** Unique-constraint and check-constraint
   violations are cheap to detect (an index lookup or a boolean expression)
   and do not require locking beyond the row/index entry being written, so
   they scale fine under contention. Foreign key checks add a `SELECT` on
   the referenced table per write - measurable at very high insert rates,
   which is why some high-throughput systems defer FK validation
   (`INITIALLY DEFERRED`) or, in extreme cases, drop FKs at the database
   layer entirely and enforce referential integrity in the application (a
   tradeoff that should be made deliberately, not by accident, per
   CLAUDE.md).
6. **What changes with multiple regions?** Not applicable yet - see the
   replication labs (24-28) for what changes once writes are not all going
   through one node.
7. **What metrics would you monitor?** Constraint-violation rate by error
   code (a spike in `23503` often means an upstream service raced ahead of
   its dependency being created; a spike in `23505` often means a retried
   request without idempotency - see Lab 15).
8. **What simpler alternative could be used?** None for referential
   integrity, uniqueness, or value-set restriction - these are exactly what
   Postgres constraints are for. For the transition problem specifically,
   the simpler alternative to a trigger is application-level validation
   before the `UPDATE`, accepting that it can be bypassed by anything that
   talks to the database directly.
9. **When should you avoid this technique?** Avoid encoding a full state
   machine as a `CHECK` constraint - it doesn't have the expressiveness for
   transition rules, and forcing it in tends to produce unreadable SQL.
   Reach for a trigger only when the invariant must hold no matter what
   writes the row; otherwise application-level state machine logic (Lab 12)
   is easier to read, test, and change.

## Interview questions

1. Why does a `CHECK` constraint on `employment_status` fail to prevent a
   `terminated -> active` transition, and what would actually stop it?
2. What's the practical difference between the `23503` and `23505` Postgres
   error classes, and what would you tell an on-call engineer to look for
   if they saw a spike of each?
3. Why keep `email` unique but not make it the primary key?
4. When would you choose `NOT VALID` + `VALIDATE CONSTRAINT` over adding a
   `CHECK` constraint directly on a large, already-populated table?
5. What does a foreign key protect against that an application-level "check
   the company exists first, then insert the employee" never fully can?
6. Why might a high-throughput system choose to drop a foreign key and
   enforce referential integrity in application code instead - and what do
   they give up by doing that?

## Further experiments

- Add a third `employment_status` value (e.g. `'on_leave'`) to the `CHECK`
  constraint via a new migration, and update the seed generator to produce
  some. Notice you cannot add a stricter `CHECK` to a populated table
  without first confirming (or backfilling) every existing row satisfies it.
- Write a `BEFORE UPDATE` trigger that raises an exception on
  `terminated -> active` and see how much more code (and how much more
  Postgres-specific knowledge) it takes compared to the `CHECK` constraint
  it complements.
- Change the naive scenario's `naive_employees.company_id` to `NOT NULL`
  (but still no foreign key) and see that a `NULL` company_id is now
  rejected while a nonexistent one still is not - notice `NOT NULL` and a
  foreign key protect two different things.
- Run `pnpm scenario:fixed` twice in a row without restarting the stack and
  confirm it's safe to rerun (it cleans up its own marker rows first).
