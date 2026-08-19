# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Connect with `psql "$DATABASE_URL"` and run `\d employees` to see the real
  `CHECK`, `UNIQUE`, `NOT NULL`, and foreign key constraints Drizzle
  generated from `src/db/schema.ts`.
- Run `pnpm scenario:naive` then browse `naive_companies` / `naive_employees`
  in PGweb (http://localhost:8402) - the bad rows are left in place for you
  to look at.
- Run `pnpm scenario:fixed` and compare the `postgresErrorCode` logged for
  each attempt against
  https://www.postgresql.org/docs/current/errcodes-appendix.html
- Try adding a third value to the `employment_status` CHECK (e.g. `'on_leave'`)
  directly with `ALTER TABLE employees DROP CONSTRAINT
  employees_employment_status_valid, ADD CONSTRAINT ... CHECK (...)` and see
  which existing rows would violate it before it can be applied.
- Try writing a trigger that *would* stop `terminated -> active` and think
  through what it would need to know (the row's previous value) that a plain
  CHECK constraint cannot see.
