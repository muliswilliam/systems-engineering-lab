# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Change `ARTIFICIAL_DELAY_MS` in `src/scenarios/naive-reservation.ts` to `0`
  and rerun `pnpm scenario:naive` several times - see how often the race
  still reproduces with no delay at all versus with it.
- Connect with `psql "$DATABASE_URL"` and run
  `SELECT status, reserved_by, reserved_until FROM seats WHERE id = <seatId>;`
  right after running `pnpm scenario:naive` to see which buyer's write
  actually landed last.
- Run `pnpm scenario:row-lock` while watching
  `SELECT * FROM pg_locks WHERE relation = 'seats'::regclass;` in another
  `psql` session - you should see many `RowExclusiveLock`/waiting rows queue
  up behind whichever transaction is currently holding the `FOR UPDATE` lock.
- Try lowering `POSTGRES_PORT`'s `max_connections` back toward the default
  100 and rerunning the 100-concurrent-attempt tests - see what error you get
  once the pool can't open enough physical connections.
- Add a `pnpm scenario:expire` + `pnpm scenario:payment` combined script that
  reserves a seat with a 1-second hold, sleeps 2 seconds, then races an
  expiration worker tick against a payment completion attempt for the same
  seat - confirm exactly one of the two ever succeeds.
