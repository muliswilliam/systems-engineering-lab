# Lab 25 - Primary + Read Replica Routing

## Why this exists

Lab 24 proved a genuine two-node Postgres primary/standby topology and
showed that the replica itself refuses to accept writes (`SQLSTATE 25006`).
That is the easy 90% of replication safety - Postgres enforces it for free.
The hard 10% is entirely on the application side: given two live
connections (`primaryPool`/`replicaPool`), which one should a given piece of
code actually use? Get this wrong and Postgres will not save you, because
the mistake is not "write to the replica" (Postgres rejects that outright) -
it is "read from the replica at the exact moment you needed to see your own
just-committed write." That read succeeds. It just returns the wrong
answer, silently. This lab is entirely about that decision.

## Learning objectives

After this lab you should be able to:

- classify any database operation into one of four routing kinds - write,
  ordinary read, read-after-write, or transaction - and state which node
  each one belongs on and why;
- reproduce a genuine (not simulated) read-after-write staleness bug caused
  purely by application-level routing, on top of replication that is
  otherwise working correctly;
- explain why a transaction can never be split across a primary connection
  and a replica connection, and reproduce the real Postgres error that
  results from trying;
- compare two different, both-correct strategies for guaranteeing a fresh
  read-after-write - "just read the primary" vs. "wait for the replica's
  LSN to catch up" - and explain the latency/load tradeoff between them;
- distinguish application-level (ORM/router) read/write routing from
  infrastructure-level routing (e.g. a proxy or PgBouncer variant that
  inspects SQL text) - see "Tradeoffs."

## Architecture

```text
                    ┌───────────────────────────┐
                    │        application         │
                    │  (this lab's router code)  │
                    └──────────────┬──────────────┘
                classify(operationKind)
                 ┌──────────────────┴──────────────────┐
                 │                                      │
        write / read-after-write / transaction       ordinary read
                 │                                      │
                 ▼                                      ▼
          ┌────────────┐   physical WAL    ┌────────────┐
          │  primary   │ ─────streaming──▶ │  replica   │
          └─────┬──────┘                   └─────┬──────┘
                ▼                                 ▼
           pgweb-primary                     pgweb-replica
```

Domain: a minimal commerce-adjacent `products` table (`id`, `public_id`,
`name`, `category`, `price_cents`, `stock_quantity`, `updated_at`), reusing
the shape of the existing `generateProducts` generator in
`@labs/data-generators` (same partial-reuse pattern Lab 21 used for its own
`products` table - `sku` is dropped, this schema has no column for it). The
four routing kinds map onto real product operations:

| Operation kind      | Example                                            | Correct node |
| -------------------- | --------------------------------------------------- | ------------ |
| `write`               | change a product's price                             | primary      |
| `read`                 | browse the catalog                                   | replica      |
| `read-after-write`     | show the price you just changed, right now           | primary      |
| `transaction`          | purchase: read stock, decrement, write - atomically  | primary      |

The two-node topology itself (`bitnami/postgresql`, env-var-driven
`POSTGRESQL_REPLICATION_MODE`) is reused as-is from Lab 24 - see that lab's
README "Architecture" for the full rationale. Independent of Lab 24: its
own Compose project name/network, its own named volumes, its own ports
(5425/8425 primary, 5525/8525 replica), its own database.

## Setup

```bash
pnpm install
cp labs/25-primary-read-replica-routing/.env.example labs/25-primary-read-replica-routing/.env
cd labs/25-primary-read-replica-routing
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate    # applies ONLY to the primary
pnpm seed          # writes ONLY to the primary
```

Confirm the topology is actually replicating before doing anything else
(the same check Lab 24 used):

```bash
docker exec -e PGPASSWORD=lab25 lab25-primary \
  psql -U postgres -d lab25 -c \
  "SELECT application_name, state, sync_state FROM pg_stat_replication;"
```

Real captured output from this lab's own validation run:

```text
 application_name |   state   | sync_state
-------------------+-----------+------------
 walreceiver      | streaming | async
(1 row)
```

Open PGweb for the primary at http://localhost:8425 and for the replica at
http://localhost:8525.

## Scenario

`src/router/router.ts` implements ONE execution engine (`createRouter`)
parameterized by a `classify(kind)` function. `src/router/classify.ts`
defines two such functions:

- `classifyNaive` - only ever asks "is this a write?" Every read - ordinary,
  read-after-write, or the read inside a transaction - falls through to the
  replica.
- `classifyCorrected` - classifies all four kinds explicitly: writes,
  read-after-write, and transactions go to the primary; only genuinely
  ordinary reads go to the replica.

Both routers share the exact same `write`/`read`/`readAfterWrite`/
`transaction` methods - the only thing that differs is which classify table
drives them. This is deliberate: the bug and the fix are not two different
pieces of machinery, they are the same machinery driven by a different
policy.

## Prediction

Before running anything, predict:

1. If you write a new price to the primary and, in the very next line of
   code, read that same row back through a router that sends ALL reads to
   the replica, will the read always be stale? Sometimes? Never?
2. What SQLSTATE does Postgres return if a `SELECT ... FOR UPDATE` (not an
   `INSERT`/`UPDATE`) is attempted against a replica connection?
3. Between "route read-after-write straight to the primary" and "keep the
   read on the replica but wait for its LSN to catch up first," which one
   has lower read latency, and which one keeps more load off the primary?

## Exercise

```bash
pnpm scenario:naive-read-after-write
pnpm scenario:corrected-read-after-write
pnpm scenario:transaction-routing
pnpm test
```

## Observe

- **`pnpm scenario:naive-read-after-write`** runs the bug two ways. Phase 1
  is the honest, natural race - no artificial delay, real loopback
  streaming replication exactly as fast as Lab 24 measured it. Real
  captured run from this lab's own validation:

  ```text
  trials: 100
  staleCount: 5
  staleRate: 0.05
  ```

  5 of 100 immediate read-after-write attempts genuinely lost the race
  against real replication, with zero artificial delay - this is the actual
  bug, not dramatized. Phase 2 makes the same bug deterministic using the
  same real `recovery_min_apply_delay` standby feature Lab 24 used (see
  that lab's README for why this is a real production feature, not a
  testing hack), so the exercise does not depend on getting lucky/unlucky
  with phase 1's natural timing:

  ```text
  delayMs: 150
  trials: 20
  staleCount: 20
  ```

  Every single trial was stale once a real, bounded replica lag exceeds the
  round-trip time of the read.

- **`pnpm scenario:corrected-read-after-write`** runs the SAME 150ms
  artificial delay, but through the corrected router. Real captured run:

  ```text
  strategy 1 (route to primary):  trials: 50, staleCount: 0, avgReadLatencyMs: 0.29
  strategy 2 (LSN-wait, replica): trials: 10, staleCount: 0, avgReadLatencyMs: 155.64 (configuredDelayMs: 150)
  ```

  Both strategies are correct (zero stale reads across every trial, even
  under real lag), but they trade latency for load differently - see "Why
  the fix works." The scenario also captures the side-by-side contrast that
  makes the classification concrete:

  ```text
  justWrotePriceCents: 9999
  ordinaryReadFromReplicaSawPriceCents: 3010
  readAfterWriteFromPrimarySawPriceCents: 9999
  ```

  The SAME moment, the SAME product, two different classifications, two
  different (both individually correct) answers.

- **`pnpm scenario:transaction-routing`** demonstrates why a transaction
  cannot be split across nodes. Real captured error when the naive router's
  classify table routes a purchase's `SELECT ... FOR UPDATE` to the
  replica:

  ```text
  code: "25006"
  message: "cannot execute SELECT FOR UPDATE in a read-only transaction"
  ```

  Note this is NOT the same statement Lab 24 tested (a plain `INSERT`) - it
  is a locking `SELECT`, which also requires write access because acquiring
  a row lock is itself a WAL-logged action. The corrected router's
  transaction, routed to the primary, succeeds and decrements stock
  correctly (`newStockQuantity: 90`, from a seeded `stockQuantity: 100`
  minus a purchase of `10`).

- **`pnpm test`** - 13 tests across 4 files, real captured run:

  ```text
  Test Files  4 passed (4)
       Tests  13 passed (13)
    Duration  4.49s
  ```

- **PGweb** (http://localhost:8425 primary, http://localhost:8525 replica) -
  browse `products` on both; after a write both should agree once the
  (fast, real) replication catches up.

## Break it

Run the naive scenario and read phase 1's `staleRate` carefully - it is
real, observed, and will differ slightly between runs (this repository's
own validation run captured `0.05`; you may see `0.00`, `0.08`, or another
small number). That variability IS the lesson: an application-level routing
bug like this does not fail every time, which is exactly what makes it
dangerous in production - it passes code review, passes a quick manual
test, and then shows up as an intermittent "my update didn't save" support
ticket that is nearly impossible to reproduce on demand, until someone
thinks to ask "was this read served by the replica?"

Phase 2 removes the luck entirely: with `recovery_min_apply_delay` real and
active, the SAME naive router is stale on 20 out of 20 trials, every single
run. Try raising `ARTIFICIAL_DELAY_MS` in
`src/scenarios/naive-router-stale-read.ts` and confirm it stays at 100%.

Then run `pnpm scenario:transaction-routing` and look at the captured
`code: "25006"` - unlike the read-after-write bug, this one is loud: the
naive router's transaction does not silently return a wrong answer, it
throws immediately, because a locking read is a write-adjacent operation
Postgres refuses on a standby. The read-after-write bug is more dangerous
precisely because it has no equivalent loud failure mode.

## Fix it

`classifyCorrected` (`src/router/classify.ts`) is the entire fix:

```ts
export function classifyCorrected(kind: OperationKind): NodeChoice {
  switch (kind) {
    case "write":
    case "read-after-write":
    case "transaction":
      return "primary";
    case "read":
      return "replica";
  }
}
```

Application code never chooses a connection string directly - it calls
`router.write(...)`, `router.read(...)`, `router.readAfterWrite(...)`, or
`router.transaction(...)` and states which KIND of operation it is doing.
The router, not the call site, is responsible for knowing which node that
kind belongs on.

## Why the fix works

Two different, individually correct strategies are implemented for
read-after-write:

1. **Route straight to the primary** (this lab's default,
   `Router.readAfterWrite`). The primary always has the value it just
   committed, by definition - there is nothing to wait for. Real captured
   latency: **0.29ms average**, completely unaffected by replica lag.
2. **Wait for the replica's LSN to catch up, then read the replica**
   (`src/router/lsn-wait.ts`, used directly in the scenario/tests). Capture
   `pg_current_wal_lsn()` on the primary right after the write, then poll
   the replica's `pg_last_wal_replay_lsn()` until it is `>=` that value,
   using `pg_lsn`'s native ordering operator - the same kind of real LSN
   inspection Lab 24 used for `pg_stat_replication`. Real captured latency:
   **155.64ms average** against a configured 150ms delay - the strategy's
   cost tracks the real lag almost exactly, because it is measuring the
   real thing rather than guessing at it.

**Why compare LSNs instead of a fixed `sleep(150)`?** A fixed sleep is a
guess about how long replication usually takes. Guess too low and the bug
reappears, intermittently, exactly like the naive router - the sleep only
makes it rarer, not impossible. Guess too high and every read-after-write
pays a fixed tax even when the replica actually caught up in 2ms (Lab 24
measured `avgLagMs: 2.51` on this same kind of loopback setup). Comparing
LSNs answers the actual question - "has the replica replayed at least this
WAL position?" - directly, instead of guessing at a proxy for it. It is
also symmetric with how Postgres itself decides whether a standby is caught
up (`pg_stat_replication`'s `replay_lsn` on the primary is the same
comparison from the other side).

Transactions have no live routing decision at all, and that is itself the
point: `Router.transaction` opens `BEGIN`/`COMMIT` on a single checked-out
connection from whichever pool `classify("transaction")` picks. Postgres
transactions are inherently single-connection - there is no protocol for
"begin part of a transaction on one server and finish it on another." The
naive router's mistake is not that it tries to do something exotic and
fails at it; it is that it never gives transactions special consideration
at all, so they fall into the same `replica` branch as every other read,
and Postgres's very first WAL-logging statement inside that transaction
(the locking `SELECT`) rejects it outright.

See `docs/replication-reference.md` for a cross-lab quick-reference on
read-write routing and the other replication labs.

## Tradeoffs

- **This lab's router is application-level, not infrastructure-level.** An
  alternative architecture puts routing in a proxy in front of both nodes
  (parsing SQL text to guess "is this a write?"). That approach can route
  connections a developer forgot to route correctly, but it CANNOT know
  "this particular read needs read-after-write freshness" - that is
  business-logic context only the calling code has. This lab's approach
  requires every call site to be honest about which kind of operation it is
  doing; a proxy-based approach removes that burden for writes vs. ordinary
  reads but cannot solve read-after-write or transaction classification for
  you.
- **Route-to-primary vs. LSN-wait for read-after-write.** Route-to-primary
  is simpler, always correct, and has no dependency on replication catching
  up - so it is this lab's default. It does put 100% of read-after-write
  traffic back on the primary, which matters if that traffic pattern is
  large. LSN-wait keeps read-after-write traffic on the replica (helping if
  the primary is the bottleneck), at the cost of added tail latency bounded
  by real replication lag, and a poll loop's added connections/round trips.
- **PgBouncer does not replace this router.** Per Lab 23, PgBouncer pools
  connections to ONE backend - it has no concept of "route this query to a
  different Postgres node based on its kind." A PgBouncer instance would
  sit in front of the primary, and a separate one in front of the replica;
  this lab's `classify()` decision still has to happen in application code
  (or in a proxy purpose-built for read/write splitting, which is a
  different piece of infrastructure than a connection pooler).
- **This lab's naive-vs-corrected distinction only matters for
  read-after-write and transactions.** For plain writes and plain reads,
  the naive and corrected classify tables agree - see the unit test
  `differs from classifyNaive on exactly the two kinds this lab is about`
  in `tests/unit/classify.test.ts`.

## Production notes

1. **What guarantee does this technique provide?** Read-after-write
   consistency for exactly the operations explicitly classified as needing
   it, and atomicity for transactions, without giving up the throughput
   benefit of routing ordinary reads to a replica.
2. **What does it not guarantee?** Freshness for OTHER clients reading the
   same data through an ordinary (replica-routed) read shortly after your
   write - that is a separate, harder problem (a second user browsing the
   catalog may still see the old price for as long as real replication lag
   lasts). Lab 26 is where this repository builds strategies for that.
3. **What breaks under process crash?** If the process crashes mid-`
   transaction`, Postgres's own transaction semantics apply exactly as they
   would on a single-node setup - the `BEGIN` never reached `COMMIT`, so
   nothing was applied. Routing adds no new crash-consistency risk here
   because a transaction was never split across nodes in the first place.
4. **What breaks under network partition?** If the application cannot reach
   the primary at all, every write, read-after-write, and transaction fails
   outright (by design - there is no "temporarily promote the replica"
   logic in this lab, see Lab 28 for failover). Ordinary reads keep working
   against the replica, serving whatever it last replayed.
5. **What changes at high contention?** More read-after-write and
   transaction traffic means more load lands on the primary regardless of
   which of the two strategies above is chosen - the LSN-wait strategy
   trades primary load for replica connection/poll overhead and added
   latency, not for zero primary involvement (the write itself is still a
   primary operation either way).
6. **What changes with multiple regions?** A cross-region replica's real
   lag (unlike this lab's ~2.5ms Lab-24-measured loopback baseline) makes
   the LSN-wait strategy's latency cost far more expensive relative to
   route-to-primary's near-zero cost - at longer real lag, routing
   read-after-write straight to the primary becomes the clearly better
   default, not just the simpler one.
7. **What metrics would you monitor?** Per-operation-kind routing counts
   (so a misclassified call site shows up as an anomaly, e.g. read-after-
   write volume suddenly appearing on the replica's query log), primary CPU
   /connection load specifically attributable to read-after-write and
   transaction traffic, and (if using LSN-wait) the distribution of
   `waitedMs`/`pollsUntilCaughtUp` values, which is a direct proxy for real
   replication lag.
8. **What simpler alternative could be used?** For a small enough read-
   after-write volume, routing EVERYTHING to the primary and never using
   the replica for reads at all is simpler and cannot exhibit this bug -
   the replica then exists purely for failover/backup purposes, not read
   scaling. This lab's whole premise (routing some reads to a replica) is
   only worth the complexity once ordinary-read volume is large enough to
   matter.
9. **When should you avoid this technique?** When your data model cannot
   tolerate a proxy-based or router-based classification mistake at all
   (e.g. financial balances where even a rare misclassified read has real
   consequences) - in that case, route everything read-after-write-
   sensitive to the primary by DEFAULT and only carve out specific,
   carefully audited ordinary-read call sites for the replica, rather than
   defaulting to the replica and trying to remember every place that needs
   an exception (which is exactly the naive router's mistake, just
   distributed across a codebase instead of centralized in one function).

## Interview questions

1. Why does a naive router's read-after-write bug show up as an
   intermittent failure rather than a hard, loud error, while its
   transaction-on-replica bug shows up as an immediate, loud one?
2. What does `pg_last_wal_replay_lsn() >= $1::pg_lsn` actually compare, and
   why is that comparison meaningful for `pg_lsn` values the same way it
   would be for byte offsets?
3. Why can't a router "fix" the transaction case by routing the transaction
   to the primary and the ordinary reads inside it to the replica?
4. Given the same read-after-write requirement, when would you choose the
   LSN-wait strategy over routing straight to the primary, and what real,
   measurable number would you look at to decide?
5. Why is `SELECT ... FOR UPDATE` rejected on a replica even though it is
   syntactically a `SELECT`, not an `INSERT`/`UPDATE`/`DELETE`?
6. A teammate proposes putting this lab's `classify()` logic into a
   PgBouncer-adjacent proxy instead of application code. What does that
   proxy need to know that it fundamentally cannot know from SQL text
   alone?
7. If read-after-write traffic on the primary grows large enough to
   threaten primary capacity, what would you look at before reaching for
   the LSN-wait strategy as a mitigation?

## Further experiments

- Increase `ARTIFICIAL_DELAY_MS` in `naive-router-stale-read.ts` and
  `corrected-router-read-after-write.ts` and confirm the LSN-wait
  strategy's `avgReadLatencyMs` tracks it closely, the same way Lab 24's
  `artificial-replication-lag.ts` confirmed `catchUpMs` tracked its own
  configured delay.
- Remove the artificial delay entirely from `naive-router-stale-read.ts`'s
  phase 1 and run it 10 times in a row - record the real `staleRate` each
  time and see how much it varies on your machine.
- Add a second replica (following Lab 24's "Further experiments" for how)
  and extend `classifyCorrected` to load-balance ordinary reads across both
  - what would you need to measure per-replica to make that decision well?
- Try implementing a THIRD read-after-write strategy: a short (e.g. 5
  second) "sticky primary window" per client after any write, and compare
  its behavior to both strategies here under the same artificial delay -
  this is a preview of Lab 26.
