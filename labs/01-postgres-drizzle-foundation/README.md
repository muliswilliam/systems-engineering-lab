# Lab 01 - PostgreSQL + Drizzle Foundation

## Why this exists

Every later lab in this repository assumes you're comfortable with the same
local loop: bring up Postgres and PGweb in Docker, apply a Drizzle migration,
seed deterministic data, and look at what actually landed in the database -
both through the ORM and through raw SQL. This lab builds that loop once so
it stops being interesting and starts being invisible, which is the point:
you want your attention on transactions and locks in Lab 05+, not on how to
start Postgres.

## Learning objectives

After this lab you should be able to:

- stand up a disposable, healthchecked Postgres + PGweb stack with Docker Compose;
- define a Drizzle schema with both an internal `bigint` identity and a public `uuid`;
- generate and apply a Drizzle migration, and read the SQL it produced;
- write a deterministic, seeded generator for realistic relational data;
- run the same query through Drizzle and through raw SQL against the same
  connection pool, and confirm they agree;
- turn on `log_statement=all` and watch the exact SQL a request produces.

## Architecture

```text
┌─────────────┐        ┌──────────────┐
│  seed.ts /  │──insert│              │
│  index.ts / │───────▶│  PostgreSQL  │◀────── pgweb (browser UI)
│  raw-sql-   │  query │  (companies, │
│  demo.ts    │◀───────│   employees) │
└─────────────┘        └──────────────┘
     Drizzle ORM              ▲
     + raw `pg` pool          │
                     docker compose (health-checked)
```

Domain: a minimal slice of the **payroll** domain (companies, employees) -
the same domain later labs (advisory locks, batch jobs) build on.

## Setup

```bash
pnpm install
cp labs/01-postgres-drizzle-foundation/.env.example labs/01-postgres-drizzle-foundation/.env
cd labs/01-postgres-drizzle-foundation
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate
pnpm seed
```

Open PGweb at http://localhost:8401 and connect (it auto-connects via
`PGWEB_DATABASE_URL`). You should see `companies` and `employees` populated.

## Scenario

A payroll company has employees. Each company and each employee needs an ID
that's safe to use internally (joins, foreign keys) and an ID that's safe to
expose externally (an API response, a URL) without leaking how many rows
exist or in what order they were created.

## Prediction

Before running anything, predict:

1. What SQL type will `bigint(...).generatedAlwaysAsIdentity()` produce in
   the migration - `SERIAL`, `BIGSERIAL`, or `GENERATED ALWAYS AS IDENTITY`?
2. If you insert an employee with a `company_id` that doesn't exist, what
   happens - a silent no-op, a warning, or a rejected transaction?
3. If you run `pnpm seed` twice in a row, do you get double the rows, an
   error, or the same dataset both times?

## Exercise

1. Run the setup commands above.
2. Open `drizzle/0000_*.sql` and check your answer to prediction #1.
3. Run `pnpm demo:raw-sql` and read the log output - it runs the same query
   through Drizzle and through a raw `pg` query and compares the row counts.
4. Run `docker compose logs postgres | tail -40` and find the exact
   `SELECT`/`INSERT` statements Drizzle sent (this works because
   `docker-compose.yml` starts Postgres with `-c log_statement=all`).

## Observe

- **PGweb** (http://localhost:8401): browse `companies` and `employees`,
  check the `public_id` column values look like UUIDs and `id` looks like a
  small sequential integer.
- **`docker compose logs postgres`**: the raw SQL statements, in order.
- **`psql "$DATABASE_URL" -c '\d employees'`**: the real column types and
  constraints Postgres created from the Drizzle schema.
- **Structured logs**: `pnpm seed` and `pnpm demo:raw-sql` log through
  `@labs/logging` (Pino) - notice every line is a JSON object with a `name`
  field identifying which script produced it.

## Break it

Run `pnpm seed` a second time without resetting the database:

```bash
pnpm seed
```

Answer prediction #3 for real this time - inspect `pnpm dev`'s row counts
before and after. Then look at `src/seed/seed.ts`: it deletes existing rows
before inserting, specifically so the seed is idempotent and safe to rerun.
Comment out the two `db.delete(...)` lines, rerun `pnpm seed` twice, and
confirm you now get double the rows - that's the failure mode the delete
step exists to prevent.

Next, try inserting an employee referencing a company that doesn't exist:

```bash
psql "$DATABASE_URL" -c "INSERT INTO employees (company_id, full_name, email, role, annual_salary_cents, currency) VALUES (999999, 'Ghost', 'ghost@example.com', 'engineer', 10000000, 'USD');"
```

This fails with a foreign key violation - Postgres refuses to create an
employee pointing at a company that isn't there.

## Fix it

There's nothing to "fix" in the traditional naive/solution sense in this
lab - the point is the baseline itself is already correct (a real foreign
key, a real unique constraint, an idempotent seed). Lab 02 is where you'll
deliberately weaken and then restore constraints to see what invalid data
looks like when they're missing.

## Why the fix works

The foreign key on `employees.company_id` is enforced by Postgres itself, not
by application code remembering to check first - so it holds even if a
future script, a manual `psql` session, or a bug forgets to validate. This is
the "keep guarantees close to the data" principle from
`docs/architecture-principles.md`, applied at its simplest.

## Tradeoffs

- **Identity columns vs `bigserial`**: `GENERATED ALWAYS AS IDENTITY` (used
  here) is the SQL-standard way to get an auto-incrementing integer and
  avoids some `bigserial` quirks around sequence ownership on dump/restore.
  It's marginally more verbose to reference from raw SQL tooling that expects
  a plain sequence.
- **UUID public IDs**: `defaultRandom()` calls Postgres's built-in
  `gen_random_uuid()` on every insert - cheap, but it does mean the UUID
  isn't known until after the `INSERT` returns, unlike a client-generated
  UUID.
- **`log_statement=all`**: extremely useful for learning, but in production
  this is expensive (every statement is written to the log) and a
  potential secret-leakage risk if statements contain sensitive literals.

## Production notes

1. **What guarantee does this technique provide?** Referential integrity
   (`employees.company_id` always points at a real company) and uniqueness
   (`public_id`, `email`) are guaranteed by Postgres, not by application code.
2. **What does it not guarantee?** Nothing here prevents *logically* wrong
   data (a salary of $1 is still a valid row) - see Lab 02 for `CHECK`
   constraints.
3. **What breaks under process crash?** A crash mid-seed leaves whatever rows
   had already committed; rerunning `pnpm seed` is safe because it starts by
   deleting and rebuilding the dataset.
4. **What breaks under network partition?** Not applicable at this scale -
   there's a single Postgres node and no replicas yet (see Lab 24+).
5. **What changes at high contention?** Not exercised in this lab - see
   Lab 10+ for row locks and Lab 11+ for conditional writes.
6. **What changes with multiple regions?** Not applicable yet.
7. **What metrics would you monitor?** Connection count, query latency,
   `pg_stat_statements` for slow queries - none of this is wired up yet
   (see Lab 38).
8. **What simpler alternative could be used?** None - this is already the
   simplest correct foundation. The interesting alternatives (skip Docker,
   use SQLite, skip the ORM) all trade away something a later lab needs.
9. **When should you avoid this technique?** `log_statement=all` should never
   run in production; it's a local-development-only setting here.

## Interview questions

1. Why model both an internal `bigint` ID and an external `uuid`, instead of
   exposing the `bigint` directly?
2. What's the practical difference between `GENERATED ALWAYS AS IDENTITY` and
   `SERIAL` in Postgres?
3. Why does the seed script delete before inserting, and what would happen to
   the `employees` table's foreign keys if it deleted in the opposite order
   (`companies` then `employees`)?
4. What does a foreign key constraint protect against that application-level
   validation alone would not?
5. Why is it useful to be able to see the same query in both Drizzle and raw
   SQL form?

## Further experiments

- Change `--size=small` to `--size=medium` or `--size=large` in `pnpm seed`
  and compare how long the seed takes with the current batch size (500 rows
  per `INSERT`).
- Add a third table (e.g. `departments`) and a new migration with
  `pnpm db:generate`, then look at the diff-only migration file Drizzle
  produces.
- Try connecting to the database with `psql` while `docker compose logs -f
  postgres` is running in another terminal, and watch statements appear in
  real time as you type them.
