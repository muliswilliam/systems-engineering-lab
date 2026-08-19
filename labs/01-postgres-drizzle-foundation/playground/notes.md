# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
(different `psql` queries, alternate Drizzle queries, throwaway scripts)
without touching the graded/checked-in code.

Ideas to try:

- Connect with `psql "$DATABASE_URL"` and run `\d employees` to see the exact
  column types and constraints Drizzle generated.
- Run `EXPLAIN SELECT * FROM employees WHERE company_id = 1;` and note there
  is no index on `company_id` yet - that's the subject of Lab 04.
- Add a throwaway query script here and run it with `pnpm tsx playground/your-script.ts`.
