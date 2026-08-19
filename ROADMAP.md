# Roadmap

Status legend: `[ ]` not started, `[-]` in progress, `[x]` complete (validated
per the Definition of Done in `CLAUDE.md`).

Port convention (avoids collisions if two labs are ever run at once): lab `NN`
uses host port `54NN` for its primary Postgres and `84NN` for its primary
PGweb. Labs with a second Postgres node (replication, capstone) use `55NN`
and `85NN` for the second node, `56NN`/`86NN` for a third, and so on. Each
lab's own README and `.env.example` are the source of truth for its actual
ports.

## Phase 1 - PostgreSQL and Drizzle Foundations

- [x] 01 - postgres-drizzle-foundation - Docker Compose + Postgres + PGweb + Drizzle + seed + raw SQL alongside Drizzle. Domain: payroll (companies, employees). Ports 5401/8401.
- [x] 02 - relational-modeling-and-constraints - naive (raw-SQL, unconstrained) vs corrected (FK, UNIQUE, CHECK, NOT NULL) schemas, asserting exact Postgres error codes (23502/23503/23505/23514) and the CHECK-can't-stop-a-transition limit. Domain: payroll (companies, employees + employment_status). Ports 5402/8402.
- [x] 03 - sql-querying-and-query-plans - joins, aggregations, CTEs, window functions, and subqueries in both Drizzle and raw SQL, plus a naive (COUNT-inflated-by-join-fan-out) vs corrected (CTE pre-aggregation) reporting query and an EXPLAIN/EXPLAIN ANALYZE walkthrough with no indexes yet. Domain: commerce (customers, products, orders, order_lines). Ports 5403/8403.
- [x] 04 - indexes-and-performance-basics - reuses Lab 03's commerce schema at 1M+ rows (seeded 60,000 customers / 500 products / ~300k orders / ~900k order_lines in ~37s via a streaming/batched generator); before/after `EXPLAIN ANALYZE` scenarios drop-then-recreate a plain B-tree, composite, partial, covering (`INCLUDE`), and expression index plus a low-selectivity index, all via a hand-written raw-SQL migration; measured real write-amplification (~29% lower insert throughput with the 6 indexes present) and index selectivity (planner ignores `idx_orders_status` for `status='paid'` at 58% of rows, uses it for `status='cancelled'` at 8%). Domain: commerce (customers, products, orders, order_lines). Ports 5404/8404.

## Phase 2 - Transactions and PostgreSQL Concurrency

- [x] 05 - transactions-and-atomicity - naive (two independent, non-transactional `UPDATE`s) vs transactional (`BEGIN`/`COMMIT`/`ROLLBACK`) money transfer, with an injected failure at the identical point in both: the naive version leaves $10.00 vanished from the system total and a transfer row stuck at `status='pending'` forever; the transactional version's `ROLLBACK` leaves both account balances and the system total byte-for-byte unchanged. Domain: banking/ledger, new (`accounts` + `transfers`). Ports 5405/8405.
- [x] 06 - mvcc-and-visibility - two-independent-`pg.Client`-session scenarios (no shared Drizzle pool) proving real xmin/xmax/ctid tuple-versioning facts: no dirty reads, READ COMMITTED's per-statement (not per-transaction) snapshot, UPDATE producing a physically new tuple found via `pageinspect.heap_page_items` (a plain ctid-filtered SELECT can't see it once the deleting tx commits), and a plain SELECT (2ms) vs `SELECT ... FOR UPDATE` (~3000ms) not blocking vs blocking a concurrent writer. Domain: a minimal standalone `counters` table (not payroll/commerce - deliberately no relational noise around the one row being versioned). Ports 5406/8406.
- [x] 07 - isolation-read-committed - two independent `pg.Client` connections drive raw `BEGIN`/`SET TRANSACTION ISOLATION LEVEL`/`COMMIT` to reproduce a non-repeatable read under the default Read Committed level (same still-open transaction, two SELECTs of the same row, a committed UPDATE in between returns a different value each time) and to prove Postgres never exposes a dirty read even when a transaction explicitly requests `READ UNCOMMITTED` - plus a direct A/B comparison showing `READ UNCOMMITTED` and `READ COMMITTED` produce byte-for-byte identical read behavior even though `SHOW transaction_isolation` echoes back whichever label was requested. Domain: banking/ledger (a single `accounts` table). Ports 5407/8407.
- [x] 08 - repeatable-read-and-snapshots - the same non-repeatable-read setup from Lab 07 replayed under `REPEATABLE READ` (one snapshot per transaction, so the second read now returns the stale pre-update value, contrasted in the same test file against a `READ COMMITTED` run of the identical setup, self-contained - no import from Lab 07), a same-row concurrent-write scenario where two `REPEATABLE READ` transactions racing to `UPDATE` one row produce exactly one commit and one `SQLSTATE 40001` ("could not serialize access due to concurrent update"), and a write-skew scenario (the canonical Postgres-docs on-call-doctors example, domain: two `on_call_staff` rows with an "at least one on call" invariant) where both transactions commit successfully yet the invariant ends up violated - Repeatable Read has no same-row conflict to catch across two different rows. Domain: banking/ledger (a fresh, non-imported copy of Lab 07's `accounts` table) plus a small on-call-staff table for write skew. Ports 5408/8408.
- [x] 09 - serializable-and-retries - fresh, self-contained "on-call staff" schema (`on_call_staff`: team/name/is_on_call, no CHECK possible since the invariant spans rows) reproducing the same write-skew anomaly Lab 08 previews: two `pg.Client` transactions under REPEATABLE READ each independently see the other still on call and both commit "go off call", leaving 0 on call; the identical interleaving under SERIALIZABLE gets a real SQLSTATE 40001 abort on one side (invariant preserved at 1 on call); a bounded retry loop with randomized backoff re-reads fresh state per attempt and reaches a terminal outcome (one commit, one correctly-and-permanently-rejected go-off-call); a 5-way concurrent contention benchmark measured Serializable+retry needing 11 total attempts/6 real conflicts to reach the correct answer vs. 5 attempts/0 conflicts under Repeatable Read that left 0 staff on call (wrong answer, no abort cost). Domain: on-call staff, new. Ports 5409/8409.

## Phase 3 - Locks and Concurrency Control

- [x] 10 - row-locks-and-select-for-update - naive plain-`SELECT`-then-absolute-`UPDATE` withdrawals lose one of two concurrent withdrawals (final balance $8,000 instead of the correct $5,000) even though `UPDATE`'s automatic row lock genuinely blocks the second writer for 263ms - blocking the write doesn't stop it overwriting with a stale-computed value; `SELECT ... FOR UPDATE` fixes it (final balance correctly $5,000, or the second withdrawal correctly rejected as insufficient funds) because the READ itself blocks (261ms observed) until the up-to-date balance is visible; also covers `NOWAIT` (instant SQLSTATE 55P03, 2ms) vs `SET LOCAL lock_timeout` (same SQLSTATE, aborts after ~504ms for a 500ms budget), `FOR SHARE` (concurrent readers, blocks writers), and verified against a real running Postgres that a plain `UPDATE` on a non-unique column takes `FOR NO KEY UPDATE` (2ms, does not conflict with a concurrent `FOR KEY SHARE`) while an `UPDATE` on a `UNIQUE` column takes full `FOR UPDATE` (255ms, blocks `FOR KEY SHARE`). Domain: banking/ledger, new minimal single-table `accounts` (independent of Labs 05's and 07's `accounts`). Ports 5410/8410.
- [x] 11 - conditional-writes-and-optimistic-concurrency - naive plain `UPDATE ... WHERE id = ?` (no version check) reproduces a real lost update (both UPDATEs report `rowCount=1`, only the later write survives) vs `UPDATE ... WHERE id = ? AND version = ?` (first writer `rowCount=1`, stale second writer `rowCount=0`, app-level re-read-and-retry then succeeds and folds in both edits) vs a plain conditional write on a business column (`WHERE status = 'draft'`, exactly 1 of 10 concurrent "publish" attempts succeeds) - plus a short side-by-side comparison script measuring pessimistic `SELECT ... FOR UPDATE` blocking (~310ms real measured wait) against optimistic's immediate `rowCount=0`. Domain: a standalone `documents` table (a wiki-page-style shared draft, not one of SPEC.md's five named domains - same rationale as Lab 06's `counters`). Ports 5411/8411.
- [x] 12 - ticket-reservation-system - naive read-then-write (SELECT status, check in app code, separate UPDATE, no transaction) vs conditional-write (`UPDATE ... WHERE status = 'AVAILABLE'`) vs row-lock (`SELECT ... FOR UPDATE`) seat reservation, each measured under 100 concurrent attempts for the same seat: naive reproducibly let 73-100 of 100 attempts believe they'd reserved the seat (real captured runs), both fixes reproducibly hit exactly 1; plus a conditional-UPDATE expiration worker (`RESERVED -> AVAILABLE` where `reserved_until < now()`) and a conditional-UPDATE payment completion (`RESERVED -> SOLD` requiring a valid, unexpired token). Domain: ticketing, new (`events` + a flat `seats` table - deliberately not SPEC.md's full venue/section/inventory model, see the lab's README "Architecture"). Ports 5412/8412.
- [x] 13 - advisory-locks - session locks (`pg_advisory_lock`/`pg_try_advisory_lock`/`pg_advisory_unlock`) and transaction locks (`pg_advisory_xact_lock`/`pg_try_advisory_xact_lock`, no unlock function, released automatically on real captured COMMIT and ROLLBACK) proving per-key granularity (worker B's try-lock on a held key returns `false`, worker C's try-lock on a different key returns `true` immediately) and connection-loss release (closing a session's connection without calling `pg_advisory_unlock` frees the key for a new session); plus the CLAUDE.md-required demonstration that a connection which never calls any `pg_advisory_*` function can `UPDATE` the exact row a lock is "protecting" in 1ms, unimpeded - advisory locks coordinate cooperating callers only, they do not lock rows; and a numeric-internal-id vs. hashed-public-UUID lock-key comparison with real birthday-paradox collision-probability numbers (32-bit vs 64-bit key space). Domain: payroll, new independent copy (companies, employees, payroll_runs). Ports 5413/8413.

## Phase 4 - Background Work and Messaging

- [ ] 14 - job-queue-skip-locked
- [ ] 15 - idempotency-and-deduplication
- [x] 16 - transactional-outbox - naive dual write reproduced in both directions (DB commits then simulated broker publish fails, leaving a durable order with zero recoverable `outbox_events` rows; simulated broker publish succeeds then the order INSERT is rejected by a real `orders_amount_cents_positive` CHECK violation (23514), leaving zero order rows despite the broker believing the event was sent) vs the fix (`BEGIN`; `INSERT order`; `INSERT outbox_event`; `COMMIT`), with a forced outbox-INSERT CHECK violation rolling back both rows together, plus a minimal one-shot (non-`SKIP LOCKED`, explicitly scoped as a Lab 17 preview) `drainOutbox` that publishes only `published_at IS NULL` rows and does not re-publish on a second run. Domain: a fresh, minimal commerce-adjacent schema, new (`orders` + `outbox_events` - deliberately not SPEC.md's full commerce model). Ports 5416/8416.
- [ ] 17 - outbox-workers-skip-locked
- [ ] 18 - inbox-pattern-and-idempotent-consumers
- [ ] 19 - message-delivery-semantics
- [ ] 20 - sagas-and-distributed-workflows

## Phase 5 - Caching and Distributed Coordination

- [ ] 21 - cache-aside-and-cache-stampede
- [ ] 22 - redis-leases-and-distributed-locks

## Phase 6 - Connections and PostgreSQL Scaling

- [ ] 23 - connection-management-and-pgbouncer
- [ ] 24 - postgres-wal-and-replication-basics
- [ ] 25 - primary-read-replica-routing
- [ ] 26 - replication-lag-and-read-after-write
- [ ] 27 - cascading-replicas
- [ ] 28 - failover-and-role-changes

## Phase 7 - Safe Schema Evolution

- [ ] 29 - safe-schema-migrations
- [ ] 30 - large-table-backfills

## Phase 8 - PostgreSQL Operations and Performance

- [ ] 31 - vacuum-autovacuum-and-bloat
- [ ] 32 - deadlocks-and-lock-debugging
- [ ] 33 - query-tuning-and-explain-analyze
- [ ] 34 - pagination-at-scale
- [ ] 35 - partitioning

## Phase 9 - Reliability Engineering

- [ ] 36 - rate-limiting-and-backpressure
- [ ] 37 - retries-timeouts-and-circuit-breakers

## Phase 10 - Observability and Security

- [ ] 38 - observability
- [ ] 39 - row-level-security-and-db-security

## Phase 11 - Capstone

- [ ] 40 - production-capstone
- [ ] 41 - system-design-drills

## Implementation notes

- Repository scaffold (root `package.json`, `pnpm-workspace.yaml`,
  `tsconfig.base.json`, `docs/`, `packages/data-generators`, `packages/db-utils`,
  `packages/logging`, `packages/test-utils`, `tools/lab.mjs`) landed alongside
  Lab 01.
- Shared packages grow incrementally: only what a given lab actually needs is
  added (e.g. `generateEvents`/`generateSeats` land with the ticketing labs,
  not before).
- Domains by lab, so far: 01 payroll, 02 payroll, 03 commerce, 04 commerce,
  05 banking/ledger (`accounts` + `transfers` audit trail), 06 counters (a
  deliberately minimal standalone domain - see Lab 06's README
  "Architecture" for why a rich relational domain would have added noise
  around the single-row tuple-versioning mechanics being taught), 07
  banking/ledger (a minimal single-table `accounts` slice - no
  `transfers`/`ledger_entries` table, since Lab 07 is about isolation
  semantics, not a rich relational model; each lab defines its own schema
  independently per the independent-labs principle, so the various
  `accounts` tables across labs are not shared), 08 banking/ledger (its own
  fresh, non-imported copy of Lab 07's minimal `accounts` slice, same
  rationale) plus a small standalone `on_call_staff` table (the canonical
  Postgres-docs write-skew domain - not one of SPEC.md section 8.2's five
  named domains, since write skew specifically needs a small,
  easy-to-reason-about cross-row invariant rather than a rich relational
  model), 09 on-call staff (its own fresh, independently-defined
  `on_call_staff` table - `team`/`name`/`is_on_call` - reusing the same
  conceptual shape as Lab 08's write-skew preview per the independent-labs
  principle, to show Serializable catching the exact anomaly Repeatable
  Read cannot), 10 banking/ledger (a FOURTH independent minimal
  single-table `accounts` slice, seeded with named "Scenario Account - ..."
  rows the way Lab 07's are - Lab 10 is about row-locking mechanics, not a
  rich relational model, and per the independent-labs principle none of
  these labs' `accounts` tables are shared or imported between labs), 11 a
  standalone `documents` table (a wiki-page/shared-draft-style domain - also
  not one of SPEC.md section 8.2's five named domains, same rationale as
  Lab 06's `counters`: the lesson is the conditional-write/version-column
  mechanism itself, and a rich relational model around it would only add
  noise; defined only in Lab 11's own schema, not shared), 12 ticketing, new
  (`events` + a flat `seats` table carrying its own `section`/`row`/
  `seat_number` columns directly, rather than SPEC.md 8.2's full
  aspirational venue/section/ticket-inventory/orders/payments model for the
  domain - see Lab 12's README "Architecture" for the scoping rationale; a
  reservation is modeled as the seat row's own state, not a separate
  `reservations` table), 13 payroll (its own independent copy of the
  companies/employees shape Lab 01 also uses, per the independent-labs
  principle - no import from Lab 01/02 - plus a new `payroll_runs` table,
  one row per company, that exists specifically to give the "advisory lock
  does not protect rows" scenario a real row to update; scenario companies
  are two fixed, named rows ("Scenario Company - Alpha (locked by Worker
  A)" / "Scenario Company - Beta (different lock key)") looked up by name,
  the same idempotent-reseed pattern Lab 07's `SCENARIO_ACCOUNTS`
  established, rather than SPEC.md's illustrative literal ids 5/6 which
  would not survive a reseed under this repository's delete-then-reinsert
  seed convention), 16 a fresh, minimal commerce-adjacent domain (`orders` +
  `outbox_events`, deliberately not SPEC.md 8.2's full commerce model - see
  Lab 16's README "Architecture" for the scoping rationale) seeded with
  Faker called directly in `src/seed/seed.ts` rather than a new
  `@labs/data-generators` file, since neither table is a generic reusable
  entity yet (same "no speculative shared machinery" reasoning as Lab 05's
  `transfers`).
- `packages/data-generators/src/commerce.ts` gained `generateOrdersBatched`
  (Lab 04) - a streaming/batched variant of `generateOrders` used for the
  1M+-row seed, purely additive so Lab 03's `generateOrders` and its callers
  are untouched. Both `commerce.ts`'s `generateCustomers` and
  `payroll.ts`'s `generateEmployees` also deduplicate faker-generated
  emails via a shared `toUniqueEmail` helper (`packages/data-generators/src/unique-email.ts`)
  - faker's name-derived emails collide often enough at Lab 01/04's
    `--size=large` scale to violate the `email` UNIQUE constraint
    otherwise; the fix is a no-op at small sizes, so Labs 01-03's existing
    seeded datasets are unaffected.
- `packages/data-generators/src/ledger.ts` added (Lab 05) - a minimal
  `generateAccounts` generator for the new banking/ledger domain. Only
  `accounts` lives in the shared package; `transfers` (this lab's audit
  trail of transfer attempts) is scenario-specific to Lab 05 and defined
  only in that lab's schema, per CLAUDE.md's guidance not to build
  speculative shared machinery ahead of a second consumer needing it.
- Lab 06 introduces `src/db/session.ts` (`openSession`), the repo's first
  two-independent-connection helper built on raw `pg.Client` rather than a
  shared Drizzle pool - needed because a shared pool cannot guarantee a
  specific transaction stays open on a specific connection while another
  script/session does something else on a different one. Later concurrency
  labs (07+) can reuse the same pattern. Lab 06 also uses the `pageinspect`
  extension (`CREATE EXTENSION IF NOT EXISTS pageinspect`, run by the lab
  itself, not a superuser-only migration step) to read raw heap page
  contents directly - an ordinary `SELECT ... WHERE ctid = $1` still
  applies MVCC visibility and cannot show a dead tuple once its deleting
  transaction has committed, so `heap_page_items(get_raw_page(...))` is the
  only way to prove the old tuple version is still physically on disk.
- `packages/data-generators/src/ticketing.ts` added (Lab 12) - deterministic
  `generateEvents`/`generateSeats` generators for the new ticketing domain,
  purely additive (a new file plus one new `export *` line in
  `packages/data-generators/src/index.ts`) so every earlier lab's generators
  and seeded datasets are untouched; Labs 01, 05, and 07 were re-validated
  (`docker compose up -d` + `pnpm db:migrate` + `pnpm seed` + `pnpm typecheck`
  + `pnpm test`, then stopped again) after this change and still pass.
