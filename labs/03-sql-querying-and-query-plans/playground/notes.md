# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
(different `psql` queries, alternate Drizzle queries, throwaway scripts)
without touching the graded/checked-in code.

Ideas to try:

- Connect with `psql "$DATABASE_URL"` and rewrite `src/scenarios/ctes.ts`'s
  two chained CTEs as a single query with a nested subquery in the `FROM`
  clause instead - compare readability, not just correctness.
- Run `EXPLAIN SELECT * FROM orders WHERE customer_id = 1;` and note there is
  no index on `customer_id` yet, so this is a sequential scan even for a
  single customer - that's the subject of Lab 04.
- Change `src/scenarios/window-functions.ts`'s running-total query to use
  `ROW_NUMBER()` instead of `RANK()` for the customer leaderboard and seed a
  couple of customers with identical revenue (edit the generator or insert
  by hand) to see the tie-breaking difference.
- Add a `refunds` table (order_id, amount_cents) with a few rows and try
  writing a report that joins orders, order_lines, AND refunds in one query -
  see the join-fan-out problem from README "Break it" reappear in a new
  shape, and pre-aggregate refunds in their own CTE branch to fix it.
- Add a throwaway query script here and run it with `pnpm tsx playground/your-script.ts`.
