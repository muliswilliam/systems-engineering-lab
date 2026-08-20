# Lab 11 - Conditional Writes and Optimistic Concurrency

## Why this exists

Lab 10 showed that `SELECT ... FOR UPDATE` protects a read-modify-write
sequence by making a second writer *wait* for the first one to finish. That
works, but it costs something: a held row lock, and an open
transaction/connection for however long the first writer takes. Most
application read-modify-write flows are not "hold the database connection
open while the user edits a form" - they're "load the record into a browser
tab, let the user type for two minutes, then send one `PUT` request." A row
lock cannot span that gap; nothing is holding a transaction open across an
HTTP request/response cycle. This lab is about the mechanism that protects
correctness anyway: never trust that the row you're about to write still
looks like the row you read - make the `UPDATE`'s `WHERE` clause say so, and
let Postgres tell you, for free, whether it still did.

## Learning objectives

After this lab you should be able to:

- reproduce a real lost update on a running Postgres instance: two "users"
  each read a row, edit it in application code, and write it back with a
  plain `UPDATE ... WHERE id = ?` - and watch one edit silently vanish while
  both writers received a completely normal, error-free response;
- implement optimistic concurrency control with a `version` column
  (`UPDATE ... SET ... WHERE id = ? AND version = ?`, incrementing `version`
  on success) and explain precisely why a stale writer's `UPDATE` returns
  `rowCount = 0` instead of throwing an exception;
- implement the application-level conflict-handling loop that a version
  column requires: detect `rowCount = 0`, re-read the current row, retry (or
  surface a conflict to the user) - this row-count check is *your*
  responsibility; Postgres does not do it for you;
- implement a plain conditional write on a business column
  (`UPDATE ... WHERE status = 'draft'`) and explain why it is optimistic
  concurrency control *without* a dedicated version counter, and exactly
  when that substitution is and is not enough;
- compare pessimistic locking, optimistic locking, and plain conditional
  writes on blocking behavior, failure mode, and the kind of invariant each
  one actually protects - not from a table someone else wrote, but from
  three real, measured runs against the same table (see "Real validation run"
  below).

## Architecture

```text
documents
  id            bigint     internal identity
  public_id     uuid       external identity
  title         text       UNIQUE - this lab's fixed scenario rows are looked
                            up by title, the same way earlier labs use a
                            fixed "Scenario Account - ..." name
  body          text       the content two users race to edit
  status        text       'draft' | 'published' - the business column used
                            by the plain-conditional-write scenario, entirely
                            independent of `version`
  version       integer    the optimistic-concurrency column - every
                            successful UPDATE increments it
  created_at    timestamptz
  updated_at    timestamptz
```

Domain: a single, deliberately minimal **document** table (think a wiki page
or a shared draft) - not one of SPEC.md 8.2's five named domains
(payroll/ticketing/commerce/banking/background-jobs). Lab 06 set the
precedent for this: when the lesson is about a concurrency-control
*mechanism* rather than a rich business domain, a small standalone table
removes relational noise that would only distract from the mechanics being
taught. One row, two competing writers, is the whole story here.

```text
src/scenarios/lost-update-naive.ts        <- BREAK IT: plain UPDATE, no version check
src/scenarios/optimistic-concurrency.ts   <- FIX IT: UPDATE ... WHERE id=? AND version=?
src/scenarios/conditional-write-publish.ts<- plain conditional write on a business column
src/scenarios/lock-comparison.ts          <- side-by-side: pessimistic vs optimistic vs conditional
src/scenarios/support.ts                  <- shared two-connection helpers
```

Every scenario uses two (or more) independent `pg.Client` connections driven
with raw SQL, never Drizzle's query builder - per `CLAUDE.md`'s "ORM plus
SQL" rule, a real concurrent-write race needs explicit control over exactly
when each connection sends each statement, which a query builder does not
model. Schema definition and migrations still use Drizzle.

## Setup

```bash
pnpm install
cp labs/11-conditional-writes-and-optimistic-concurrency/.env.example labs/11-conditional-writes-and-optimistic-concurrency/.env
cd labs/11-conditional-writes-and-optimistic-concurrency
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate
pnpm seed --seed=42 --size=small
```

Open PGweb at http://localhost:8411 (it auto-connects via
`PGWEB_DATABASE_URL`). You should see a `documents` table with 4 fixed
"Scenario Document - ..." rows plus a handful of faker-generated "browsing"
wiki pages.

## Scenario

Two people open the same shared draft document at (nearly) the same time -
in a browser tab each, exactly like a wiki page or a shared design doc. Each
person edits a different part of the document and clicks "save." Neither
person's screen shows any error. What ends up saved?

## Prediction

Before running anything, predict:

1. If both users' "save" is a plain `UPDATE documents SET body = $1 WHERE id
   = $2`, with nothing in the `WHERE` clause referencing what either user
   actually read, what does Postgres report back to each user's `UPDATE`?
   Does either one fail?
2. If the `UPDATE` instead has `WHERE id = $2 AND version = $3` (the version
   each user read), and the first user's `UPDATE` commits and bumps
   `version`, what does the SECOND user's `UPDATE` report - an error, or
   something else?
3. If a "publish" button issues `UPDATE documents SET status = 'published'
   WHERE id = $1 AND status = 'draft'`, and ten people click "publish" on the
   same still-draft document at the same instant, how many of those ten
   `UPDATE`s actually change a row?
4. Which of the three mechanisms above makes a concurrent writer *wait*, and
   which ones let it proceed immediately and find out afterward that it
   lost?

## Exercise

1. Run the setup commands above.
2. Run `pnpm scenario:naive` and read the log output - both users' `UPDATE`s
   report `rowCount = 1`, but the final `body` only contains one of the two
   edits.
3. Run `pnpm scenario:optimistic` and read the log output - the first user's
   conditional `UPDATE` matches, the second user's (stale-version) attempt
   matches zero rows, and the retry (after re-reading the fresh version)
   succeeds and folds in both edits.
4. Run `pnpm scenario:conditional-write` and read the log output - ten
   concurrent "publish" attempts against the same draft document, exactly
   one of which changes a row.
5. Run `pnpm scenario:lock-comparison` and read the log output - all three
   mechanisms, back to back, against the same table, so you can compare
   blocking behavior directly.
6. Run `pnpm test` and read the assertions - they check actual `rowCount`
   values and actual final document bodies, never statement ordering or
   timing.

## Observe

- **PGweb** (http://localhost:8411): browse `documents` after each scenario
  run and watch `version`, `status`, and `body` settle at the post-scenario
  values for each "Scenario Document - ..." row.
- **`docker compose logs postgres`**: with `log_statement=all`, you can see
  the exact `UPDATE ... WHERE id = ? AND version = ?` and
  `SELECT ... FOR UPDATE` statements each scenario sent, in the order
  Postgres actually received them.
- **Structured logs**: every scenario logs through `@labs/logging` (Pino),
  including the literal `rowCount` returned by every `UPDATE`, and final
  boolean verdict fields (`lostUpdateOccurred`, `conflictDetected`,
  `retrySucceeded`, `bothEditsPresent`).
- **`rowCount`, not exceptions**: nowhere in this lab does a conflicting
  write throw. Every conflict shows up as `rowCount = 0` on an otherwise
  completely normal `UPDATE` - the application has to be the one watching for
  it.

## Break it

Run:

```bash
pnpm scenario:naive
```

Real captured output from this lab's own validation run:

```text
user A: opened the document for editing (plain SELECT)
  userAReadBody: "This shared draft describes the Q3 rollout plan. Section 1: overview. Section 2: timeline."

user B: opened the SAME document for editing (plain SELECT) - before A has saved anything
  userBReadBody: "This shared draft describes the Q3 rollout plan. Section 1: overview. Section 2: timeline."

user A: UPDATE (plain, no version check) - looks successful to A's client
  rowCount: 1

user B: UPDATE (plain, no version check) - ALSO looks successful to B's client
  rowCount: 1

LOST UPDATE: both UPDATEs reported rowCount=1 (success), but user A's edit is gone
  userAEditedBody: "...Section 2: timeline.\n\n-- User A's addition: fixed the typo in Section 1."
  userBEditedBody: "...Section 2: timeline.\n\n-- User B's addition: added a Section 3 on rollout risks."
  finalBody:       "...Section 2: timeline.\n\n-- User B's addition: added a Section 3 on rollout risks."
  userAEditSurvived: false
  userBEditSurvived: true
  lostUpdateOccurred: true
```

Both `UPDATE`s reported `rowCount = 1`. Neither user's client - in a real
app, neither HTTP `PUT /documents/:id` request - ever saw an error. User A's
fix to the typo in Section 1 is not in the final document, not queued
anywhere, not recoverable: user B's `UPDATE` overwrote the entire `body`
column with a value computed from a read that happened *before* A's write
ever occurred. This is the textbook lost update, produced by two ordinary,
individually-correct SQL statements with nothing tying either of them back
to the row version each user actually saw.

## Fix it

Run:

```bash
pnpm scenario:optimistic
```

Real captured output, same shape of concurrent edit, this time with a
version-column conditional write:

```text
both users read the document - same body, same version (a stale read is about to happen for B)
  userAReadVersion: 1
  userBReadVersion: 1

user A: conditional UPDATE (WHERE id = ? AND version = ?) - matches, version advances
  rowCount: 1
  newVersion: 2

user B: conditional UPDATE matched ZERO rows - version already moved on. Conflict detected, no data was overwritten.
  rowCount: 0
  attemptedVersion: 1

user B: re-read the fresh version and retried the conditional UPDATE
  rowCount: 1
  retryVersion: 2

CONFLICT DETECTED AND RESOLVED: user B's stale write was rejected (rowCount=0), the retry succeeded, and the final document contains BOTH edits
  userAUpdateRowCount: 1
  userBFirstAttemptRowCount: 0
  userBRetryReadVersion: 2
  userBRetryUpdateRowCount: 1
  finalVersion: 3
  finalBody: "This shared draft describes the Q3 rollout plan. Section 1: overview. Section 2: timeline.\n\n-- User A's addition: fixed the typo in Section 1.\n\n-- User B's addition: added a Section 3 on rollout risks."
  conflictDetected: true
  retrySucceeded: true
  bothEditsPresent: true
```

User A's `UPDATE id = ? AND version = ?` matched (the row's version really
was `1`, exactly what A read), so it committed and bumped `version` to `2`.
User B's own first attempt used the SAME stale `version = 1` value the naive
scenario used - but by the time B's `UPDATE` ran, no row had `version = 1`
anymore, so `rowCount = 0`. This is the entire mechanism: not an exception,
not a retry Postgres does for you, just an ordinary `UPDATE` whose `WHERE`
clause nobody's current row satisfies.

**This lab's exact retry strategy** (so "both edits reflected" is a precise,
testable claim, not a vague one): on `rowCount = 0`, re-read the row's
*current* `body` and `version`, re-apply the SAME edit on top of the fresh
body (not the stale one), and retry the conditional `UPDATE` with the fresh
version. The final body is therefore the original text, followed by A's
edit, followed by B's edit - in commit order, because B's retry read
happened after A's commit. `finalVersion = 3` because exactly two
conditional writes ever succeeded against this row (A's first attempt, then
B's retry) - B's own failed first attempt never touched the row at all.

The plain conditional write (`WHERE status = 'draft'`) is the third
mechanism this lab covers - `pnpm scenario:conditional-write` fires 10
concurrent "publish" `UPDATE`s at the same still-draft document:

```text
firing concurrent publish attempts at the same draft document
  attemptCount: 10

EXACTLY ONE publish succeeded out of 10 concurrent attempts - WHERE status = 'draft' is the invariant
  rowCounts: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  successCount: 1
  conflictCount: 9
  finalStatus: "published"
```

There is no `version` column involved anywhere in this query. The
`status = 'draft'` predicate in the `WHERE` clause IS the invariant: once any
one `UPDATE` flips the row to `published`, every other concurrently-issued
`UPDATE`'s `WHERE` clause stops matching, and Postgres's own row-level
locking (not application code) serializes the ten concurrent statements so
that exactly one of them is the one that finds the row still `draft`.

## Why the fix works

A `WHERE` clause is not just a filter for `SELECT` - it is Postgres's
mechanism for expressing "only touch this row if it still looks like X."
`UPDATE ... WHERE id = ? AND version = ?` asks Postgres to find a row that is
BOTH identified by `id` AND still at the exact `version` the writer read. If
another transaction committed a change to that row in between the writer's
`SELECT` and its `UPDATE`, the row's `version` has already moved - the
`WHERE` clause matches zero rows, and Postgres reports `rowCount = 0` on an
otherwise completely ordinary, successful statement. No lock was held across
the gap between the read and the write (there was no transaction spanning
both), and no exception was thrown - the database simply told the truth
about how many rows matched the condition asked for.

The plain conditional write (`WHERE status = 'draft'`) works by the exact
same mechanism, with the business column standing in for a version counter:
the `WHERE` clause's condition and the invariant being protected
("don't publish something already published") are the same statement.
Postgres's row-level locking guarantees that when multiple `UPDATE`s target
the same row concurrently, they are applied one at a time in some order;
whichever one runs while `status` is still `'draft'` wins, and by the time
any other queued `UPDATE` re-evaluates its `WHERE` clause, `status` has
already changed - so it matches zero rows too.

See `docs/transaction-anomalies.md` for a cross-lab quick-reference on the
lost update and the other anomalies Labs 06-09 cover.

## Tradeoffs

- **Pessimistic locking (`SELECT ... FOR UPDATE`, Lab 10) blocks and waits.**
  It is safe - a second writer physically cannot proceed until the first one
  releases the lock, so there is never a moment where two conflicting writes
  both look successful. The cost is reduced concurrency (every other writer
  queues up behind the lock holder) and the requirement that the lock holder
  keep an open transaction/connection for however long it takes to finish -
  fine for a short read-modify-write inside one request, awkward or
  impossible for "the user is editing a form for two minutes." This lab's
  `pnpm scenario:lock-comparison` measured a real, concrete block: user B's
  `SELECT ... FOR UPDATE` took **310ms** to return, entirely because it was
  waiting on user A's held lock (see "Real validation run" below).
- **Optimistic locking (`WHERE id = ? AND version = ?`, this lab's focus)
  never blocks.** Every writer proceeds immediately; conflicts are detected
  after the fact, as `rowCount = 0`, with zero lock-wait time. The cost shows
  up as application complexity: every single write path that uses this
  pattern must check `rowCount` and decide what to do about a conflict
  (retry, merge, or surface it to the user) - Postgres will not do this for
  you, and a codebase that forgets the check has silently reintroduced the
  lost-update bug. It also means a writer's work (the edit, the request
  round-trip) can be wasted if it loses the race - a cost pessimistic locking
  avoids by preventing the race from happening in the first place.
- **Plain conditional writes (`WHERE status = 'draft'`) are optimistic
  concurrency control without a version counter.** They're simpler - no
  extra column, no "increment version" logic - but they only protect the
  EXACT invariant encoded in the `WHERE` clause. `WHERE status = 'draft'`
  stops a document from being published twice; it says nothing about two
  people concurrently editing that document's `body` while it's still a
  draft, because "still a draft" does not change when the `body` changes.
  Reach for this pattern specifically for state transitions (`draft ->
  published`, `pending -> claimed`, `available -> reserved`); reach for a
  version column when "any concurrent change at all should conflict" is the
  actual requirement.
- **Choosing between them is a question about the invariant, not a
  performance preference.** If the business rule really is "only one
  transition out of this state is allowed," a conditional write on that
  state is the simplest correct mechanism - a version column would work too,
  but adds a column and a concept the business rule doesn't need. If the
  invariant is "the writer must not clobber a change they never saw," you
  need either a lock (pessimistic) or a version column (optimistic); a plain
  business-column conditional write cannot express that requirement.

## Production notes

1. **What guarantee does this technique provide?** A conditional write
   (version column or business column) guarantees that an `UPDATE` only
   takes effect if the row still matches the exact condition the writer
   checked for - so a writer can always tell, from `rowCount` alone, whether
   its write actually applied against the data it thought it was modifying.
2. **What does it not guarantee?** It does not merge conflicting edits for
   you - this lab's retry strategy (re-read, re-apply, retry) is one
   deliberate choice; a real application might instead show the user a
   "someone else edited this, please review" screen. It also does not
   prevent a *stale read* from ever happening - it only prevents a stale
   write from succeeding silently.
3. **What breaks under process crash?** Nothing new: a crash before the
   conditional `UPDATE` runs means the write never happened (same as any
   unsent request); a crash after `COMMIT` means it already happened and is
   durable. The one thing to design for deliberately: a crash *between*
   detecting `rowCount = 0` and completing a retry leaves the user's edit
   unsaved, exactly as if the request had simply failed - the client needs
   to know to retry or resubmit, the same as any other failed write.
4. **What breaks under network partition?** Not applicable yet - single
   Postgres node, no replicas (see Lab 24+). A partitioned client that
   cannot reach Postgres to retry simply cannot save; nothing in this
   mechanism is more or less fragile to a partition than any other write.
5. **What changes at high contention?** Optimistic concurrency degrades
   gracefully but wastefully: under very high contention on one row, most
   writers' conditional `UPDATE`s fail and must retry, so effective
   throughput on that ONE row is not much better than a lock would give -
   the advantage is that OTHER rows are completely unaffected, since no lock
   is held across requests. Plain conditional writes on a business column
   behave the same way: 10 concurrent publish attempts in this lab all
   resolved instantly (Postgres serializes them internally), but 10,000
   concurrent publish attempts on the same single row would still all
   contend for that one row's lock briefly, even though 9,999 of them are
   guaranteed to lose immediately rather than queue for long.
6. **What changes with multiple regions?** Not applicable yet - all of this
   lab's guarantees are single-node, single-writer-database. A
   multi-region, multi-primary setup would need to reconcile `version`
   conflicts across regions, which is a much harder problem this lab does
   not attempt (see the replication phase, Labs 24-28, for read-side
   multi-region concerns instead).
7. **What metrics would you monitor?** Conflict rate (`rowCount = 0` on
   conditional `UPDATE`s, as a fraction of attempts) is the key signal - a
   rising conflict rate on a specific row or row class means rising
   contention, which is either expected (a genuinely hot resource) or a sign
   the granularity of what you're version-checking is too coarse (e.g.
   versioning an entire multi-field record when only one field actually
   needs conflict detection).
8. **What simpler alternative could be used?** If only one specific state
   transition needs protecting, a plain conditional write on the business
   column (no version column) is simpler and sufficient - see the `status =
   'draft'` scenario above. If the read-modify-write happens entirely within
   one request/transaction and can tolerate holding a lock for that
   duration, `SELECT ... FOR UPDATE` (Lab 10) is simpler to reason about
   (no retry loop) at the cost of blocking.
9. **When should you avoid this technique?** Avoid a version column when a
   plain conditional write on an existing business column already expresses
   the exact invariant you need (don't add complexity you don't need). Avoid
   optimistic concurrency generally when conflicts are frequent enough that
   the retry cost dominates - a table under constant heavy contention on the
   same rows is often better served by pessimistic locking or by redesigning
   the data model (e.g. an append-only log of intents instead of a single
   mutable row) to reduce contention in the first place.

## Interview questions

1. Why does a stale-version `UPDATE` return `rowCount = 0` instead of
   throwing an exception? What would have to be true of Postgres's execution
   model for it to throw instead?
2. Walk through exactly what would happen if the naive lost-update scenario
   in this lab used `SELECT ... FOR UPDATE` for the initial read but still
   used the same plain `UPDATE ... WHERE id = ?` with no version check
   afterward - would that fix the bug? Why or why not?
3. When would optimistic concurrency beat a row lock, and when is it the
   wrong choice?
4. Why can a plain conditional write on a business column (`WHERE status =
   'draft'`) NOT protect a document's `body` from a lost update, even though
   it perfectly protects the `status` transition?
5. If `rowCount = 0` after a conditional `UPDATE`, what are the two broad
   strategies an application can take next, and what user-facing tradeoff
   does each one make?
6. Why does this lab's optimistic-retry scenario re-read the CURRENT body
   before retrying, instead of just retrying the exact same `UPDATE`
   statement with the exact same values but a newer version number?
7. A teammate proposes replacing this lab's `version integer` column with
   `updated_at timestamp` as the optimistic-concurrency check
   (`WHERE id = ? AND updated_at = ?`). What could go wrong with that
   substitution that an integer counter avoids?

## Further experiments

- In `src/scenarios/optimistic-concurrency.ts`, change the retry strategy so
  that on conflict, the application throws a `ConflictError` back to the
  caller instead of automatically re-reading and retrying - update the test
  file to assert on the new behavior, and think about which real UIs want
  each strategy.
- Increase `DEFAULT_ATTEMPT_COUNT` in
  `src/scenarios/conditional-write-publish.ts` to 100 or 1000 and confirm
  `successCount` is still always exactly 1, regardless of how many
  concurrent connections race for the row.
- In `src/scenarios/lock-comparison.ts`, increase the artificial delay
  before user A's `COMMIT` (currently 300ms, only there to sequence this
  demo script's own log lines) and confirm user B's measured
  `userBBlockedForMs` scales with it almost exactly - the block is real
  database lock-wait time, not a fixed timeout.
- Add a fourth "user C" to `optimistic-concurrency.ts` who also read version
  1 and also tries to save - work out by hand what `rowCount` each of C's
  attempts should produce depending on whether it runs before or after B's
  retry, then confirm your prediction in code.
- Open two `psql "$DATABASE_URL"` sessions and reproduce the version-column
  conflict by hand (see `playground/notes.md`) - watch `UPDATE 0` appear in
  your own terminal instead of reading it from a log line.

## Real validation run (captured output)

The following are actual values captured from a real run against this lab's
Docker Compose stack (not hypothetical/aspirational output).

**`pnpm scenario:naive`:**

```json
{"documentId":"10","userAReadBody":"This shared draft describes the Q3 rollout plan. Section 1: overview. Section 2: timeline."}
{"documentId":"10","userBReadBody":"This shared draft describes the Q3 rollout plan. Section 1: overview. Section 2: timeline."}
{"documentId":"10","rowCount":1}
{"documentId":"10","rowCount":1}
{"userAUpdateRowCount":1,"userBUpdateRowCount":1,"userAEditSurvived":false,"userBEditSurvived":true,"lostUpdateOccurred":true}
```

**`pnpm scenario:optimistic`:**

```json
{"documentId":"11","userAReadVersion":1,"userBReadVersion":1}
{"documentId":"11","rowCount":1,"newVersion":2}
{"documentId":"11","rowCount":0,"attemptedVersion":1}
{"documentId":"11","rowCount":1,"retryVersion":2}
{"userAUpdateRowCount":1,"userBFirstAttemptRowCount":0,"userBRetryUpdateRowCount":1,"finalVersion":3,"conflictDetected":true,"retrySucceeded":true,"bothEditsPresent":true}
```

**`pnpm scenario:conditional-write`:**

```json
{"documentId":"12","attemptCount":10}
{"rowCounts":[1,0,0,0,0,0,0,0,0,0],"successCount":1,"conflictCount":9,"finalStatus":"published"}
```

**`pnpm scenario:lock-comparison`:**

```json
{"documentId":"13","userBBlockedForMs":310,"finalBody":"...\n\n-- User A's addition (pessimistic).\n\n-- User B's addition (pessimistic)."}
{"userAUpdateRowCount":1,"userBFirstAttemptRowCount":0,"userBRetryUpdateRowCount":1}
{"successCount":1,"conflictCount":9}
```

`pnpm test` (7 tests across 3 files) and `pnpm typecheck` both pass cleanly
against this output:

```text
✓ tests/integration/optimistic-concurrency.test.ts (3 tests)
✓ tests/integration/lost-update.test.ts (2 tests)
✓ tests/integration/conditional-write-publish.test.ts (2 tests)

Test Files  3 passed (3)
     Tests  7 passed (7)
```

The full reset flow (`docker compose down -v && docker compose up -d`,
then `pnpm db:migrate && pnpm seed && pnpm test`) was verified to work from a
clean slate as part of this lab's validation.
