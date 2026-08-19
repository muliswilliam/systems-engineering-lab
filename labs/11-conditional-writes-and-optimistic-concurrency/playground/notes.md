# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Open two `psql "$DATABASE_URL"` sessions side by side and reproduce the
  lost update by hand:
  - Session 1: `SELECT body, version FROM documents WHERE title = 'Scenario Document - Lost Update';`
  - Session 2: `SELECT body, version FROM documents WHERE title = 'Scenario Document - Lost Update';`
  - Session 1: `UPDATE documents SET body = body || ' [A]' WHERE title = 'Scenario Document - Lost Update';`
  - Session 2: `UPDATE documents SET body = body || ' [B]' WHERE title = 'Scenario Document - Lost Update';`
  - `SELECT body FROM documents WHERE title = 'Scenario Document - Lost Update';`
    - notice the `[A]` you wrote in session 1 is nowhere in the final body.
- Now retry it with the version column: add `AND version = 1` to both
  session's UPDATEs (`UPDATE documents SET body = body || ' [A]', version = version + 1 WHERE title = '...' AND version = 1;`)
  and watch the second session's `UPDATE 0` - by hand, character by character,
  instead of through the scenario script.
- Try `SELECT ... FOR UPDATE` in session 1 inside `BEGIN`, then run the same
  `SELECT ... FOR UPDATE` in session 2 - session 2 hangs until session 1
  commits or rolls back. Kill session 1's connection instead of committing
  and watch session 2's query immediately unblock (a dropped connection
  releases its locks, just like a crash would).
- Change `DEFAULT_ATTEMPT_COUNT` in `src/scenarios/conditional-write-publish.ts`
  to 100 or 1000 and rerun `pnpm scenario:conditional-write` - confirm
  `successCount` is always exactly 1, no matter how many concurrent attempts
  race for the same `WHERE status = 'draft'` row.
- Try changing the optimistic-concurrency retry strategy in
  `src/scenarios/optimistic-concurrency.ts` from "append B's edit onto the
  fresh body" to "throw a conflict error to the caller instead of retrying"
  and think about which real-world UIs want automatic merge-and-retry versus
  a "someone else edited this, please reload" dialog.
