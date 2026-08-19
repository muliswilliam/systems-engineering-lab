# Lab 15 - Idempotency and Deduplication

## Why this exists

A client sends a payment request. The server processes it - in this lab,
"processing a payment" means inserting a row into `payments`, which is
already the durable side effect being protected, not a stand-in for calling
some other system - and the `INSERT` commits successfully. But the HTTP
response carrying that success back to the client never arrives: the
connection resets, a proxy times out, the client's own request timer fires a
moment too soon. From the client's point of view, this looks exactly like a
request that never reached the server at all. Its retry logic does the only
reasonable thing: it resends the exact same logical request. If the server
has no way to recognize "I've already done this," it processes the retry as
a brand-new charge - a real, second, unwanted payment for the same logical
intent. This lab makes that double charge happen for real, against a real
Postgres table, under real concurrency - and then fixes it with the
mechanism Postgres has built in for exactly this problem: a `UNIQUE`
constraint on a client-supplied idempotency key, combined with
`INSERT ... ON CONFLICT DO NOTHING RETURNING *` and a fallback `SELECT` that
hands the retrying caller back the ORIGINAL result instead of a new one.

## Learning objectives

After this lab you should be able to:

- explain precisely why a naive "just insert the payment" endpoint duplicates
  a charge when a lost response causes a client to retry - and why generating
  a *fresh* idempotency key on every retry is just as broken as having no key
  at all, even with a `UNIQUE` constraint sitting right there in the schema;
- implement the `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING *` / fallback `SELECT` pattern, and explain why the `UNIQUE`
  constraint - not application-level locking - is what actually resolves the
  race between concurrent retries;
- distinguish "duplicate suppression" (at most one row is ever inserted) from
  the full idempotency contract (every caller, including every loser of a
  concurrent race, receives back the exact same response the very first
  caller would have received) - and demonstrate both as real, separate,
  passing test assertions;
- explain why a "cached result" pattern is a distinct concept from plain
  deduplication whenever processing computes something non-deterministic
  (a confirmation code, a computed fee): the retry must return the ORIGINAL
  computed value, not a value it just recomputed itself.

## Architecture

```text
payments (id, public_id, idempotency_key UNIQUE (nullable),
          amount_cents, payee, status,
          confirmation_code, processing_fee_cents, created_at)
```

A fresh, self-contained domain (SPEC.md 8.2's "Commerce" domain lists
`payments` as an entity, but this table is deliberately narrower and shaped
entirely around idempotent request handling, not a full order/checkout
model - see Lab 06's `counters` and Lab 11's `documents` for the same
"small standalone table, not one of the five named domains" rationale). The
`INSERT` into this one table IS the side effect this lab protects against
duplication; no external payment processor is called anywhere.

`idempotency_key` is nullable and carries a plain `UNIQUE` constraint.
Postgres never treats two `NULL`s as equal for a `UNIQUE` constraint, so many
rows with a `NULL` key are allowed side by side - this is what lets the naive
scenario demonstrate "no idempotency key at all" without a second schema. The
SAME table and the SAME constraint are used by every scenario below; only the
application behavior changes. That is deliberate: a unique constraint alone
does nothing if nobody supplies a stable key to it.

Three scenario scripts, all sharing `src/scenarios/payment-utils.ts`:

```text
src/scenarios/naive-retry.ts            <- plain INSERT, no dedup discipline
src/scenarios/idempotent-insert.ts      <- UNIQUE key + ON CONFLICT DO NOTHING + fetch-cached-result
src/scenarios/cached-result-pattern.ts  <- same pattern, extended to a non-deterministic computed result
```

All three use the raw `pg` `Pool` directly rather than Drizzle's query
builder - per `CLAUDE.md`'s "ORM plus SQL" principle, `ON CONFLICT` and
conflict-aware `RETURNING` are exactly the kind of Postgres-specific behavior
that should be shown as real SQL. Schema definition and migrations still use
Drizzle.

## Setup

```bash
pnpm install
cp labs/15-idempotency-and-deduplication/.env.example labs/15-idempotency-and-deduplication/.env
cd labs/15-idempotency-and-deduplication
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate
pnpm seed --seed=42 --size=small   # 20 historical, already-settled payments
```

Open PGweb at http://localhost:8415 (auto-connects via `PGWEB_DATABASE_URL`).
You should see 20 rows in `payments`, each with a distinct `idempotency_key`,
until you run one of the scenario scripts below.

## Scenario

A payment API accepts charge requests. Each request carries an amount and a
payee. The server "processes" the charge by inserting a `payments` row -
that insert committing is the entire definition of "the charge happened" in
this lab. The one invariant that must hold no matter how many times a client
retries:

> One logical payment intent produces exactly one `payments` row, and every
> response the client ever receives for that intent - the original and every
> retry - is identical.

## Prediction

Before running anything, predict:

1. If a client retries a charge request with no idempotency key at all, what
   happens to the `payments` table? Does the `UNIQUE` constraint on
   `idempotency_key` help, given that column is nullable?
2. If a client's retry logic calls `randomUUID()` again on every retry
   instead of reusing the key from the original attempt, does the `UNIQUE`
   constraint on `idempotency_key` prevent a duplicate row? Why or why not?
3. Ten concurrent callers all retry the same logical payment with the SAME
   idempotency key, at (as close as a single process can get to) the exact
   same instant. How many rows get inserted? Do all ten callers receive the
   same response, or does the "losing" nine get an error?
4. If "processing" a payment also computes a random confirmation code, and a
   retry recomputes that code instead of reusing the original, what does the
   caller see - and does the row count alone reveal that bug?

## Exercise

1. Run the setup commands above.
2. Run the naive scenario:
   ```bash
   pnpm scenario:naive
   ```
3. Run the fixed scenario:
   ```bash
   pnpm scenario:idempotent
   ```
4. Run the cached-result extension:
   ```bash
   pnpm scenario:cached-result
   ```
5. Run `pnpm dev` and look at `idempotencyKeysWithMoreThanOneRow` - this is
   the exact reconciliation query a production on-call engineer would run to
   discover the naive bug happening for real.
6. Run `pnpm test` and read through the three files under
   `tests/integration/` - they assert the exact invariants above as real,
   automated, concurrency-driven checks.

## Observe

- **PGweb** (http://localhost:8415): browse `payments` after running all
  three scenario scripts - filter by `payee LIKE 'Naive%'` and count rows per
  distinct payee/amount pair; then filter by `payee LIKE 'Idempotent%'` or
  `payee LIKE 'Cached%'` and confirm exactly one row per pair.
- **`docker compose logs postgres`**: `log_statement=all` makes the literal
  `INSERT ... ON CONFLICT DO NOTHING RETURNING *` and the fallback
  `SELECT ... WHERE idempotency_key = $1` both visible - compare how many
  `SELECT`s appear per scenario run (one per caller that lost the race).
- **Structured logs**: every scenario script logs through `@labs/logging`
  (Pino) with row counts, distinct-ID counts, and `wasNewlyInserted` flags on
  every attempt, so the invariant (or its absence) is a field in the log
  line, not something you have to compute by hand.
- **`SELECT idempotency_key, count(*) FROM payments WHERE idempotency_key IS
  NOT NULL GROUP BY idempotency_key HAVING count(*) > 1;`**: should always
  return zero rows - the `UNIQUE` constraint makes it structurally
  impossible, no matter how many times any scenario runs.

## Break it

Run:

```bash
pnpm scenario:naive
```

Real captured output from this lab's own validation run:

```text
--- 1. naive retry, NO idempotency key, sequential ---
first attempt processed - response about to be 'lost'
  payment: { id: "41", publicId: "9cbea243-cec5-4d0b-9180-75f88d62a5a4" }
DOUBLE CHARGE: one logical payment now has more than one row
  firstId: "41"   retryId: "42"   rowCount: 2

--- 2. naive retry, FRESH idempotency key per attempt, 10-way concurrent ---
NO PROTECTION: every concurrent retry inserted its own row - a UNIQUE
constraint on idempotency_key exists but never fires, because every key
really is different
  attempts: 10   rowCount: 10
  ids: ["43","47","51","52","48","44","46","45","50","49"]
```

The first attempt inserted row `41`. The client's retry logic - having never
seen a response - resent the exact same logical request; the server had no
way to recognize it, and row `42` is a real second charge for the same
$49.99, from the same payee, that should have been one payment.

The second run is the more interesting bug: this client DOES generate an
idempotency key on every attempt - it just generates a *new* one each time
instead of reusing the key from the original request. Even though
`idempotency_key` has a real `UNIQUE` constraint in the schema, ten
concurrent retries produced ten rows, because the constraint has nothing to
compare - every key really is a distinct, valid, never-before-seen UUID. A
`UNIQUE` constraint cannot deduplicate values it was never given a reason to
treat as equal.

`pnpm test`'s `tests/integration/naive-retry.test.ts` captures the identical
facts as real assertions, at higher concurrency (25 concurrent attempts, one
real connection per attempt via a dedicated pool):

```text
✓ naive payment insert (no ON CONFLICT, no dedup discipline)
  ✓ happy path: a single attempt inserts exactly one row
  ✓ CORRUPTS the invariant: N concurrent retries with NO idempotency key
    produce N rows for one logical payment          (25 attempts -> 25 rows)
  ✓ provides NO PROTECTION when each retry generates its own fresh
    idempotency key                                  (25 attempts -> 25 rows)
```

## Fix it

Run:

```bash
pnpm scenario:idempotent
```

Real captured output, same client-retry shape, the only difference being
that the client now generates ONE idempotency key up front and reuses it:

```text
--- 1. idempotent retry, SAME key, sequential ---
first attempt processed - response about to be 'lost'
  payment: {
    id: "53", public_id: "0872b65d-...", idempotency_key: "6810f944-...",
    amount_cents: 4999, payee: "Idempotent Sequential Merchant - 43bde545",
    status: "completed", confirmation_code: null, processing_fee_cents: null
  }
  wasNewlyInserted: true
NO DUPLICATE: exactly one row exists, and the retry received back the
identical row
  firstId: "53"   retryId: "53"   sameRow: true   retryWasNewlyInserted: false
  rowCount: 1

--- 2. idempotent retry, SAME key, 10-way concurrent ---
EXACTLY ONE ROW INSERTED, and all 10 concurrent callers received the
identical response
  attempts: 10   rowCount: 1   distinctRowIds: 1   distinctPublicIds: 1
  newlyInsertedCount: 1
```

Ten concurrent callers, same idempotency key: exactly one row landed in the
table (`newlyInsertedCount: 1`), and all ten calls' return values collapsed
to a single distinct row id and a single distinct public id - not just "no
duplicate," but "every caller, including the nine that lost the race,
received back byte-for-byte the same response."

`pnpm scenario:cached-result` extends this to a "processing" step that also
computes something genuinely non-deterministic:

```text
--- cached result pattern, SAME key, 10-way concurrent ---
CACHED RESULT CONFIRMED: all 10 calls independently computed their OWN
confirmation code, but all 10 received back the SAME persisted code and fee
- 9 of the 10 locally-computed values were correctly discarded
  attempts: 10   rowCount: 1   newlyInsertedCount: 1
  distinctPersistedConfirmationCodes: 1   distinctPersistedProcessingFees: 1
  distinctLocallyComputedConfirmationCodes: 10
```

All ten calls ran the simulated payment processor and each computed its own,
essentially-guaranteed-to-be-unique confirmation code
(`distinctLocallyComputedConfirmationCodes: 10`) - but the value actually
persisted, and the value every one of the ten callers was handed back, is a
single shared value (`distinctPersistedConfirmationCodes: 1`). Nine of the
ten locally-computed confirmation codes were computed and then correctly
thrown away.

`pnpm test` (8 tests across 3 files, all passing) captures every one of
these facts as an assertion, including response-equality checks across every
concurrent caller - not just a row count:

```text
✓ tests/integration/idempotent-insert.test.ts (3 tests)
✓ tests/integration/cached-result-pattern.test.ts (2 tests)
✓ tests/integration/naive-retry.test.ts (3 tests)

Test Files  3 passed (3)
     Tests  8 passed (8)
```

`pnpm dev`'s reconciliation report, run after every scenario script and the
full test suite above:

```text
current database state
  totalPayments: 147
  paymentsWithNoIdempotencyKey: 52
  idempotencyKeysWithMoreThanOneRow: 0
```

Fifty-two rows with no idempotency key at all (all from the naive scenario's
first sub-demo and its own test) - and yet, across every idempotency key that
actually exists, not one of them is attached to more than one row. That is
the invariant this lab protects, stated exactly the way a production
monitoring query would state it.

## Why the fix works

`INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING *` asks
Postgres to attempt the insert and, if it collides with the `UNIQUE`
constraint on `idempotency_key`, silently skip it instead of raising an
error. The `RETURNING *` clause only produces a row when the insert actually
happened - zero rows means "a row with this key already existed." The
application then falls back to `SELECT * FROM payments WHERE idempotency_key
= $1` to fetch that existing row and returns it to the caller, exactly as if
it were the first response.

The concurrency safety comes entirely from Postgres's own unique index, not
from any application-level lock: when two `INSERT`s race for the same key,
the second one physically blocks on the first inserter's transaction (the
index has to know whether the first insert will commit or roll back before
it can decide whether there's really a conflict). Once the first transaction
commits, the second sees the conflict and takes the `DO NOTHING` path - by
the time its fallback `SELECT` runs, the winning row is guaranteed to already
be committed and visible. This is CLAUDE.md's "prefer datastore-native
guarantees" principle in its purest form: no advisory lock, no `SELECT ...
FOR UPDATE`, no distributed lock - a single `UNIQUE` constraint plus one
`ON CONFLICT` clause is both necessary and sufficient.

The naive version fails for a much simpler reason than "no locking": it
never gives Postgres a stable value to enforce uniqueness against in the
first place. A `UNIQUE` constraint on a column that either holds `NULL` or a
fresh, never-repeated value every single time is, correctly, never violated
- there is genuinely nothing duplicate about ten different UUIDs. The bug is
entirely in the client's retry discipline (generate the key once, reuse it
forever for that logical request), not in the schema.

## Tradeoffs

- **The idempotency key is a client responsibility the server cannot
  enforce.** Nothing stops a buggy client from generating a fresh key per
  retry (this lab's own naive scenario #2) - the server-side `UNIQUE`
  constraint is necessary but not sufficient; it only helps a client that
  actually reuses its key.
- **`ON CONFLICT DO NOTHING` plus a follow-up `SELECT` is two round trips on
  the "I lost the race" path**, versus one round trip on the "I won" path.
  For a payment API this asymmetry is a non-issue (the second round trip only
  happens on a retry, which is already the unhappy path); for extremely
  high-throughput idempotent writes it is worth measuring.
- **The idempotency key needs a retention/expiry policy in a real system**
  (not implemented in this lab): an unbounded `UNIQUE` index on every payment
  intent ever made grows forever. Real payment APIs (e.g. Stripe) expire
  idempotency keys after a bounded window (typically 24 hours) and document
  that retries outside that window are treated as new requests.
- **A cached result is only as good as what got persisted alongside it.**
  `cached-result-pattern.ts` stores `confirmation_code`/`processing_fee_cents`
  on the SAME row and in the SAME `INSERT` as the rest of the payment - if
  they were written by a separate, later statement, a crash between the two
  writes could leave a payment row with no cached result to return on retry,
  reintroducing exactly the kind of non-atomic-multi-write problem Lab 05
  covers.

## Production notes

1. **What guarantee does this mechanism provide?** At most one `payments` row
   ever exists per idempotency key, enforced by Postgres regardless of how
   many retries race concurrently or how the application code is written;
   every caller (original and every retry) receives the identical persisted
   result.
2. **What does it not guarantee?** That the client generates and reuses a
   correct idempotency key - see this lab's naive scenario #2, where a real
   `UNIQUE` constraint provides zero protection against a client that
   generates a fresh key per attempt. It also does not protect any side
   effect that lives *outside* this database row (e.g. an actual call to a
   third-party processor) - a full production idempotency design must also
   make that external call itself safe to retry, or gate it behind the same
   row (e.g. only call the processor after this row is confirmed newly
   inserted).
3. **What breaks under process crash?** Nothing new: the `INSERT ... ON
   CONFLICT DO NOTHING RETURNING *` is a single statement, atomic on its own
   (see Lab 05). A crash between that statement and the fallback `SELECT`
   just means the retry-of-the-retry runs the same two steps again from
   scratch - it is itself idempotent.
4. **What breaks under network partition?** Not applicable at this scale -
   single Postgres node (see Lab 24+). The scenario this lab models (a lost
   HTTP response between the application and the *client*) is exactly the
   failure mode idempotency exists to solve regardless of what causes the
   loss.
5. **What changes at high contention?** Many concurrent retries for the same
   key serialize briefly on the unique index (the losers block until the
   winner commits) - for a single payment intent this is a handful of
   milliseconds at most. At very high overall request volume, the
   `idempotency_key` index itself becomes another index to maintain on every
   insert (write amplification, see Lab 04).
6. **What changes with multiple regions?** Not covered here - a
   multi-region payments system typically needs the idempotency key lookup
   to hit the same authoritative region/shard as the original request, which
   is a routing problem this single-node lab does not address.
7. **What metrics would you monitor?** Rate of `ON CONFLICT` hits (a
   directly observable proxy for "how often are clients actually retrying"),
   count of idempotency keys with more than one associated row (should
   always be exactly zero - this lab's `pnpm dev` report is that query), and
   idempotency-key table/index growth rate (informs retention policy).
8. **What simpler alternative could be used?** None, for this exact
   guarantee - a `UNIQUE` constraint is already the simplest correct
   mechanism Postgres offers. The main design choice is really at the
   application layer: whether to fail loudly on a raw unique-violation
   instead of using `ON CONFLICT DO NOTHING` (viable, but then the
   application must catch the specific `23505` error and perform the same
   fallback `SELECT` itself - strictly more code for the same outcome).
9. **When should you avoid this technique?** When the operation truly has no
   meaningful "logical identity" to key on (e.g. a pure read), or when the
   client cannot be trusted/required to generate and persist a stable key
   across its own retries - in that case, deduplication has to move
   somewhere else entirely (e.g. a deterministic key derived from the
   request's own immutable contents, if one exists).

## Interview questions

1. Why does a real `UNIQUE` constraint on `idempotency_key` provide zero
   protection against a client that generates a new key on every retry? What
   has to be true about the key for the constraint to do anything at all?
2. Walk through exactly what happens, mechanically, when two concurrent
   `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` statements race for
   the same key. Which one blocks, and on what?
3. Why is "at most one row is ever inserted" not the whole idempotency
   contract? Give an example of an implementation that satisfies row-count
   deduplication but still gives two different retrying callers two
   different answers.
4. In `cached-result-pattern.ts`, every one of ten concurrent callers
   computes its own confirmation code before finding out whether it lost the
   race. Why is that safe, and what would have to be true for it to be
   unsafe?
5. What would you need to add to this lab's design to make an idempotency
   key safely reusable for one purpose but not silently reusable forever
   (i.e. add an expiry)?
6. If the "processing" step in this lab also had to call a real external
   payment processor (not just insert a row), where in `performIdempotentPaymentAttempt`
   would you place that call, and why does placement matter for the
   guarantee to still hold?

## Further experiments

- Remove the `ON CONFLICT (idempotency_key) DO NOTHING` clause from
  `performIdempotentPaymentAttempt` (leave the `UNIQUE` constraint in the
  schema) and rerun the concurrent test - watch it fail with a raw
  `duplicate key value violates unique constraint` error on nine of the ten
  attempts instead of gracefully falling back.
- Increase `CONCURRENCY` in `tests/integration/idempotent-insert.test.ts`
  from 25 to a few hundred and confirm the invariant (`rowCount === 1`,
  every response identical) still holds no matter how high the fan-in gets.
- Change `naive-retry.ts`'s "fresh key per attempt" variant to derive the key
  from a coarse timestamp (e.g. `Date.now()` truncated to the second) instead
  of `randomUUID()`, and see how many concurrent attempts it takes before two
  attempts happen to collide on the same value and the `UNIQUE` constraint
  fires "by accident" - a good illustration of why a real idempotency key
  must be generated once per logical request, never derived from something
  that merely usually varies.
- Add a deliberate `await new Promise(r => setTimeout(r, 50))` between the
  `INSERT` and the fallback `SELECT` in `performIdempotentPaymentAttempt` and
  confirm the concurrent test's result is completely unaffected - the
  ordering between one caller's own insert and select never affects which
  row wins the race.
- Extend `cached-result-pattern.ts`'s schema and function to also store a
  `webhook_sent_at` timestamp, and think through (you don't have to
  implement it) how you'd guarantee that column is set exactly once even
  though multiple concurrent retries could all reach the "this was newly
  inserted" branch across different logical keys at once.
