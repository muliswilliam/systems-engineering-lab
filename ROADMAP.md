# Roadmap

Status legend: `[ ]` not started, `[-]` in progress, `[x]` complete (validated
per the Definition of Done in `CLAUDE.md`).

Port convention (avoids collisions if two labs are ever run at once): lab `NN`
uses host port `54NN` for its primary Postgres and `84NN` for its primary
PGweb. Labs with a second Postgres node (replication, capstone) use `55NN`
and `85NN` for the second node, `56NN`/`86NN` for a third, and so on. Labs
that add Redis (Lab 21+) use `64NN`, mirroring the same pattern. Each lab's
own README and `.env.example` are the source of truth for its actual ports.

New with Lab 23: labs that add PgBouncer use host port `63NN` for their
first PgBouncer instance. A lab needing more than one PgBouncer instance
(Lab 23 needs two - one per pool mode, since PgBouncer's `pool_mode` is one
setting per instance) increments sequentially from there (`6323`, `6324`,
...) rather than jumping to a new `NN`-suffix block, since multiple
PgBouncer instances in one lab is a lab-specific need, not a second
Postgres node.

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

- [x] 14 - job-queue-skip-locked - real 1/5/50-concurrent-worker draining of a shared `jobs` table via `SELECT ... FOR UPDATE SKIP LOCKED` (raw SQL, one claim transaction per job): 5 workers over 100 jobs each claimed exactly 20 (wall clock 71ms), 50 workers over 250 jobs each claimed exactly 5 with zero double-claims (wall clock 125ms; a fresh 200-job integration-test run measured 94ms); a `locked_until` lease lets a job whose worker never releases it (simulated crash) become reclaimable and completed by a different worker (measured reclaim latency 15ms past a 300ms lease); bounded retries via `attempts`/`max_attempts` move a job to a terminal `failed` status after 3 failed attempts and it is never claimed again; a real measured contrast (plain `FOR UPDATE` blocked a second worker for 312ms behind the first worker's lock vs. `SKIP LOCKED` resolving in 10ms by skipping to a different row) makes the naive-vs-fixed case concrete. No `workers` table - workers are ephemeral, identified only by a `worker_id` string on `job_attempts` (see README "Architecture" for why). Domain: background processing, new (`jobs` + `job_attempts`). Ports 5414/8414.
- [x] 15 - idempotency-and-deduplication - a fresh, self-contained `payments` table (idempotency_key UNIQUE, nullable) where the naive scenario reproduces a real double charge (2 rows for one logical payment with no key, then 10 concurrent retries -> 10 rows even with a real UNIQUE constraint present, because each retry generates its own fresh key instead of reusing one) vs `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING *` + fallback `SELECT` producing exactly 1 row from 10 concurrent same-key retries, with every one of the 10 callers proven (not just row-counted) to receive an identical response; a third scenario extends the pattern to a non-deterministic computed result (a random confirmation code + fee), proving a retry gets back the ORIGINAL persisted value even though every one of 10 concurrent callers independently computed its own, different value first. Domain: a fresh, standalone `payments` table (not the full SPEC.md 8.2 commerce order/checkout model - the same "small standalone table" rationale as Lab 06's `counters`/Lab 11's `documents`). Ports 5415/8415.
- [x] 16 - transactional-outbox - naive dual write reproduced in both directions (DB commits then simulated broker publish fails, leaving a durable order with zero recoverable `outbox_events` rows; simulated broker publish succeeds then the order INSERT is rejected by a real `orders_amount_cents_positive` CHECK violation (23514), leaving zero order rows despite the broker believing the event was sent) vs the fix (`BEGIN`; `INSERT order`; `INSERT outbox_event`; `COMMIT`), with a forced outbox-INSERT CHECK violation rolling back both rows together, plus a minimal one-shot (non-`SKIP LOCKED`, explicitly scoped as a Lab 17 preview) `drainOutbox` that publishes only `published_at IS NULL` rows and does not re-publish on a second run. Domain: a fresh, minimal commerce-adjacent schema, new (`orders` + `outbox_events` - deliberately not SPEC.md's full commerce model). Ports 5416/8416.
- [x] 17 - outbox-workers-skip-locked - a fresh, self-contained `outbox_events` table (`pending`/`processing`/`published`/`failed`) claimed via the same `SELECT ... FOR UPDATE SKIP LOCKED` + lease pattern Lab 14 established, rebuilt independently: 10 workers draining 30 seeded events claimed exactly 30 unique rows with zero double-claims (wall clock 30ms), and 300 events drained the same way in 119ms; a dedicated crashed-publisher demonstration then proves the limitation CLAUDE.md requires be taught explicitly - a worker claims an event, a simulated broker genuinely accepts it, the worker "crashes" before recording that fact, a second worker reclaims the lease-expired row and also calls the broker, and a real measured `brokerCallCount: 2` for one logical event proves SKIP LOCKED's safe claim does not make delivery exactly-once; an idempotent-consumer-preview scenario then replays the identical interleaving through a Postgres-native `INSERT ... ON CONFLICT DO NOTHING` dedup check (`processed_events`, unique on `event_public_id`) and shows the same 2 broker calls produce exactly 1 applied side effect - explicitly scoped in the README as a preview of Lab 18, not a full inbox implementation. No real broker - an in-process `createSimulatedBroker` (succeed/fail/slow modes, records every call) per CLAUDE.md's infrastructure-minimalism guidance. Domain: background processing/messaging (order-lifecycle event types: `OrderCreated`/`PaymentCaptured`/`OrderShipped`/`InventoryAdjusted`/`RefundIssued`), new (`outbox_events` + `processed_events`) - does not model Lab 16's write side or `orders` table. Ports 5417/8417.
- [x] 18 - inbox-pattern-and-idempotent-consumers - a fresh, self-contained `accounts` + `processed_messages` schema (no import from Lab 17) demonstrating two distinct broken consumers and one fix, all consuming a simulated `CreditApplied` message (no real broker): a naive consumer with no dedup check at all double-applies a sequentially-redelivered message (real captured overcharge of exactly one credit amount, 2500 cents); a subtler check-then-insert consumer that DOES query `processed_messages` first but as a separate, non-atomic statement still double-applies the effect under real CONCURRENT redelivery (a deliberate 50ms delay between the check and the insert made the race reliably reproducible; one worker's bookkeeping INSERT visibly conflicts with a real Postgres 23505 unique_violation after its UPDATE has already committed - proving a dedup table's own integrity says nothing about the guarantee it was meant to provide); and the fix, `INSERT ... ON CONFLICT (message_id) DO NOTHING` plus the business-effect UPDATE inside one transaction, verified exactly-once under both sequential redelivery and real 10-way/20-way concurrent redelivery (captured `appliedCount: 1`, `duplicateCount: 9` and, in the test suite, 1/19 at 20-way concurrency, over separate real connections via `@labs/test-utils`'s `runConcurrently`). Domain: banking/ledger, a fifth independent `accounts` slice reusing the shared `generateAccounts` generator, plus a new `processed_messages` inbox table defined only in this lab. Ports 5418/8418.
- [x] 19 - message-delivery-semantics - a simulated, deterministic, seed-controlled network (message can be lost in transit, or the acknowledgment can be lost - two distinct failure points) drives three side-by-side delivery mechanisms sharing one `sendWithRetry` function: at-most-once (send once, never retry - a dropped message shows 1 `delivery_log` row and 0 receiver-side effects, real captured run), at-least-once with message-loss (2 `delivery_log` rows - 1 lost, 1 acked - receiver processes exactly once) vs. the same mechanism's ack-loss case (2 `delivery_log` rows, BOTH genuinely reaching the receiver - a real, asserted duplicate: `receiver_processed_count = 2`), and effectively-once (the identical ack-loss interleaving and the identical retry mechanism, only the receiver differs - an idempotent `processed_message_ids` UNIQUE-constraint check inside the same transaction as the business effect - `delivery_log` still shows 2 transport-level attempts, but `receiver_processed_count = 1`). Domain: a fresh, self-contained "notifications" domain (`notifications` + `delivery_log` + `processed_message_ids`), not imported from Labs 16-18 despite being their closest conceptual synthesis. Ports 5419/8419.
- [x] 20 - sagas-and-distributed-workflows - a fresh, self-contained order-lifecycle schema (`orders`, `inventory_items`, `inventory_reservations`, `payments`, `shipments`, plus a `saga_log` observability table) implementing the same four-step `CreateOrder -> ReserveInventory -> CapturePayment -> CreateShipment` workflow two ways against shared, mechanism-agnostic step functions: orchestration (one coordinator function calling every step and, on failure, every compensation in reverse order) and choreography (an in-process event bus, no coordinator, each of 4 named "services" reacting only to the event immediately before it, including a full reverse compensation chain `ShipmentFailed -> PaymentRefunded -> InventoryReleased -> OrderCancelled`); a forced `createShipment` failure after payment is captured triggers `refundPayment`/`releaseInventory`/`cancelOrder`, verified against real captured numbers (inventory count restored exactly, e.g. 90 -> 90 units, not just a status flag) and proven equivalent between both mechanisms; `saga_log` real captured counts for the identical business outcome show choreography needs measurably more indirection to trace (happy path 13 rows/4 actors vs. orchestration's 5 rows/0 named actors; failure-and-compensation 20 rows/4 actors vs. 7 rows/0 actors). No `@faker-js/faker` dependency - the inventory catalog is a small fixed 5-SKU list, not a generated one. Ports 5420/8420.

## Phase 5 - Caching and Distributed Coordination

- [x] 21 - cache-aside-and-cache-stampede - naive GET/miss/compute/SET cache-aside reproduces a real cache stampede (a 300-concurrent-request cold-cache burst against one product key produced a real measured `databaseCallCount: 300`, i.e. one slow database call per concurrent miss) vs. four independent mitigations measured against the identical burst: in-process request coalescing (an in-flight-promise map collapsed the same 300-request burst to exactly 1 database call, real captured run), a Redis `SET key value NX PX` lease simulated across 5 independent `ioredis` connections as 5 "processes" (300 total requests across them, `databaseCallCount: 1`, consistent across reruns; tests assert `<=2` to document a narrow, deliberately-unresolved lease-expiry race), stale-while-revalidate (a request past the 300ms fresh window but within the 5000ms stale window returned in a real measured 4ms vs. naive cache-aside's ~79ms full-database-latency miss, with a deduplicated background refresh bringing the entry current), and jittered TTL (200 keys populated at the same instant with a fixed 2000ms TTL all expired within one 25ms poll tick of each other - a measured 0ms spread - vs. a real measured 801ms expiration spread for the same 200 keys with a +/-20% jittered TTL). First lab in the repo to add Redis (`redis:7-alpine`, health-checked via `redis-cli ping`, no persistent volume) alongside Postgres+PGweb, per CLAUDE.md's explicit "Redis for caching/distributed-lock labs" allowance. Domain: a fresh, minimal commerce-adjacent `products` table (id/public_id/name/price_cents only - see README "Architecture" for the scoping rationale), seeded via `@labs/data-generators`'s existing `generateProducts`. Ports 5421/8421/6421 (new `64NN` Redis port convention, mirroring the existing `54NN`/`84NN` pattern).
- [x] 22 - redis-leases-and-distributed-locks - a real Redis `SET NX PX` lock with an atomic Lua-script release (ownership token checked and deleted in one round trip, contrasted against a deliberately unsafe GET-then-DEL release that really does delete a different owner's lock after a real expiry-and-reacquire gap); the central bug (a 200ms-TTL lock held by a worker doing 400ms of unrenewed work) reproducibly lets a second worker acquire the "same" lock 261ms in and both workers write to a fresh `resource_state` table with real overlapping timestamps and zero errors raised (captured run: worker A writes at 401ms, worker B acquires at 261ms - genuine overlap); the fix (a Redis `INCR`-issued fencing token plus a Postgres conditional `UPDATE ... WHERE fencing_token < $1`, the same conditional-write pattern as Lab 11) replays the identical interleaving and rejects the stale worker's late write outright (`rowCount: 0`) even though that worker's own lock-holder logic never detected the expiry, while the newer, higher-token worker's write is accepted; a complementary heartbeat lease-renewal scenario shows renewal keeping a lock alive across 1000ms of work under a 200ms TTL via 16 real renewals, then shows its honest best-effort limit (a simulated 500ms GC-pause-style gap still lets a competitor steal the lock). Domain: a fresh, standalone `resource_state` table (id/public_id/name/fencing_token/last_writer/updated_at), same "small standalone table, mechanism is the point" rationale as Lab 06's `counters`/Lab 11's `documents`. Adds Redis (`redis:7-alpine`, health-checked via `redis-cli ping`) alongside Postgres/PGweb, independent of Lab 21's separate Redis usage. Ports 5422/8422/6422 (Postgres/PGweb/Redis).

## Phase 6 - Connections and PostgreSQL Scaling

- [x] 23 - connection-management-and-pgbouncer - direct-connection exhaustion reproduced against a deliberately-lowered `max_connections=30` (50 concurrent direct connections: 29 succeeded, 21 real `SQLSTATE 53300` rejections, 364ms) vs the same style of burst multiplexed through a transaction-pooling PgBouncer instance (60 concurrent clients, all succeeded, peak real Postgres backends measured via `pg_stat_activity` never exceeded `default_pool_size=10`); two PgBouncer instances (`pgbouncer-session`/`pgbouncer-transaction`, ports 6323/6324 - see the port-convention note above) since `pool_mode` is one setting per instance; session-state incompatibility demonstrated with a custom GUC, a temp table, and a prepared statement (session pooling preserved 5/5 trials, transaction pooling 0/5, each backed by a real, distinct Postgres error) - `SET application_name` was tried first and found to be a bad marker, since PgBouncer tracks and replays it across backends in every pool mode; `default_pool_size` tuning measured directly (40 concurrent clients: pool size 2 took 1062ms, pool size 20 took 199ms). Domain: a fresh, minimal `widgets` table (id/public_id/name/value) - this lab is about connection/pooling mechanics, not data modeling. Ports 5423/8423, PgBouncer 6323/6324.
- [x] 24 - postgres-wal-and-replication-basics - a genuine two-node `bitnami/postgresql` primary/standby topology (physical async streaming replication, driven entirely by `POSTGRESQL_REPLICATION_MODE`/`POSTGRESQL_MASTER_HOST` env vars rather than hand-authored `pg_hba.conf`/`pg_basebackup`, since Docker Hub only serves bitnami's `latest` tag for free as of 2025, currently PostgreSQL 18.6); real captured replication lag across 20 sequential primary writes (min 0.40ms / max 7.56ms / avg 2.51ms on a local loopback network), a real `pg_current_wal_lsn()` advance (`0/3060388` -> `0/3063508`, 12,672 bytes per `pg_wal_lsn_diff()`) cross-checked against `pg_stat_replication`'s `sent_lsn`/`write_lsn`/`flush_lsn`/`replay_lsn` all matching the replica's own `pg_last_wal_replay_lsn()`, a real captured SQLSTATE 25006 ("cannot execute INSERT in a read-only transaction") from a direct write attempt against the replica, and a real, deterministic ~300ms stale-read window produced via Postgres's own `recovery_min_apply_delay` standby feature (not a fake/simulated delay) with a measured 303.8ms catch-up. Domain: a fresh, minimal standalone `widgets` table - not one of SPEC.md 8.2's five named domains, same "small standalone table, the lesson is the mechanism" rationale as Lab 06's `counters`/Lab 11's `documents`/Lab 19's `notifications`. Ports 5424/8424 (primary), 5524/8524 (replica).
- [x] 25 - primary-read-replica-routing - one execution engine (`createRouter`) parameterized by a pure, unit-tested `classify(kind)` routing table over four operation kinds (`write`/`read`/`read-after-write`/`transaction`), reusing Lab 24's two-node `bitnami/postgresql` primary/replica topology as-is (own ports/volumes/project name, no shared state); the naive classify table (all reads incl. read-after-write and transaction -> replica) reproduced a REAL, un-simulated read-after-write staleness bug two ways - a natural race with zero artificial delay (real captured run: 5 of 100 immediate write-then-read trials via the naive router were stale, `staleRate: 0.05`) and a deterministic version using the same real `recovery_min_apply_delay` standby feature Lab 24 used, set to 150ms (20 of 20 trials stale, 100%); the corrected classify table (read-after-write and transaction -> primary) verified 0 stale reads across 50 trials under the identical 150ms delay via its default "route to primary" strategy (real captured avg read latency 0.29ms, un-affected by lag) and, as an explicitly-offered alternate strategy, 0 stale reads across 10 trials via a real `pg_last_wal_replay_lsn() >= targetLsn` comparison instead of a fixed sleep (real captured avg latency 155.64ms, tracking the configured 150ms delay almost exactly - see the lab's README for why LSN comparison beats guessing at a sleep duration); a third scenario proved transactions cannot be split across nodes with a real captured Postgres rejection (`SQLSTATE 25006`, "cannot execute SELECT FOR UPDATE in a read-only transaction") when the naive table routes a purchase's locking read to the replica, versus the corrected table's identical transaction succeeding on the primary and correctly decrementing seeded stock (100 -> 90 for a quantity-10 purchase); 13 tests across 4 files (1 pure classify-table unit test file, 3 real-database integration test files) passed in a real captured 4.49s run; full `docker compose down -v` -> `up -d` cycle re-confirmed `pg_stat_replication` showing a connected, streaming replica, both PGweb instances reachable (HTTP 200), and the seed script confirmed idempotent (identical row count on a second run). Domain: commerce-adjacent, a fresh, independent `products` table (id/public_id/name/category/price_cents/stock_quantity/updated_at) reusing the shape of the EXISTING `generateProducts` generator (`name`/`category`/`unitPriceCents` carried over as `name`/`category`/`priceCents`, `sku` dropped - no column for it, same partial-reuse pattern Lab 21 established), `stock_quantity` generated separately via its own seeded Faker instance. Ports 5425/8425 (primary), 5525/8525 (replica).
- [ ] 26 - replication-lag-and-read-after-write
- [ ] 27 - cascading-replicas
- [ ] 28 - failover-and-role-changes

## Phase 7 - Safe Schema Evolution

- [x] 29 - safe-schema-migrations - a real, reproduced production incident (`ALTER TABLE ... RENAME COLUMN full_name TO display_name` against a throwaway copy of the table, then old application code's `SELECT full_name` fails immediately with a real captured SQLSTATE `42703`, "column \"full_name\" does not exist") vs. the expand/contract fix walked through as four genuinely distinct phases against the real `customers` table: (a) `ALTER TABLE ADD COLUMN display_name text` (nullable, no default) measured at 1.19ms regardless of table size; (b) a dual-write insert/update path that sets both columns together; (c) a batched, resumable backfill (200-row batches, 500 seeded rows backfilled in exactly 3 batches of 200/200/100, resumability proven by seeding a sentinel value a rerun must not overwrite); (d) a read-path switch proven correct for both a pre-existing (backfilled) row and a newly dual-written row in the same pass. Also covers a real measured contrast between a plain `CREATE INDEX` (blocked 1957ms behind a 2000ms-held write-locking transaction - the full duration) and `CREATE INDEX CONCURRENTLY` against the identical setup (an unrelated third-party write succeeded in 3ms while the concurrent build was still in flight, never blocked), plus `lock_timeout` (a real measured 1454ms indefinite block with no `lock_timeout` set vs. a real captured SQLSTATE `55P03`, "canceling statement due to lock timeout," failing in 507ms against a 500ms budget for the identical held lock). Domain: commerce-adjacent, a fresh, independent `customers` table (reusing the shape of the existing `generateCustomers` generator) - not imported from Lab 03/04's own `customers` table. Ports 5429/8429.
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
  seed convention), 14 background processing (SPEC.md section 8.2's
  "Background processing" domain, new - `jobs` + `job_attempts`;
  `packages/data-generators/src/jobs.ts` gained the reusable `generateJobs`
  generator, exported from `index.ts`, purely additive alongside the
  existing payroll/commerce/ledger/ticketing generators - Labs 01 and 05
  were re-validated and are unaffected), 15 a fresh, standalone `payments`
  table (idempotency keys/duplicate-charge protection, not SPEC.md 8.2's
  full commerce order/checkout model - same "small standalone table, not
  one of the five named domains" rationale as Lab 06's `counters` and
  Lab 11's `documents`; defined only in Lab 15's own schema, not shared),
  16 a fresh, minimal commerce-adjacent domain (`orders` + `outbox_events`,
  deliberately not SPEC.md 8.2's full commerce model - see Lab 16's README
  "Architecture" for the scoping rationale) seeded with Faker called
  directly in `src/seed/seed.ts` rather than a new `@labs/data-generators`
  file, since neither table is a generic reusable entity yet (same "no
  speculative shared machinery" reasoning as Lab 05's `transfers`), 17
  background processing/messaging (a fresh, independent `outbox_events` +
  `processed_events` schema - deliberately not Lab 16's `orders` table or
  outbox: Lab 17's focus is the PUBLISHING side only, so its outbox rows
  are seeded directly rather than written by a modeled order-creation
  flow; `packages/data-generators/src/outbox.ts` gained the new
  `generateOutboxEvents` generator, order-lifecycle event types
  (`OrderCreated`/`PaymentCaptured`/`OrderShipped`/`InventoryAdjusted`/
  `RefundIssued`), purely additive alongside the existing generators -
  Labs 01 and 05 were re-validated and are unaffected), 18 banking/ledger
  (a fifth independent `accounts` slice, reusing the shared
  `generateAccounts` generator the same way Lab 05 does - per the
  independent-labs principle this `accounts` table is not shared or
  imported from Lab 05/07/08/10 - plus a new `processed_messages` inbox/
  dedup table, scenario-specific to Lab 18 and defined only in that lab's
  schema, not added to the shared package since it has no reusable shape
  beyond this one lab's concept), 19 a fresh, self-contained "notification
  platform" domain (`notifications` + `delivery_log` +
  `processed_message_ids`) - not one of SPEC.md 8.2's five named domains
  and deliberately not imported from Labs 16-18 despite being their
  closest conceptual synthesis, per the independent-labs principle; same
  "small standalone table, not a rich relational model" rationale as
  Lab 06's `counters`/Lab 11's `documents`/Lab 15's `payments`. Seeded with
  Faker called directly in `src/seed/seed.ts`, same reasoning as Lab 16,
  20 a fresh, self-contained order-lifecycle domain (`orders`,
  `inventory_items`, `inventory_reservations`, `payments`, `shipments`,
  `saga_log` - no import from Lab 16's `orders`/`outbox_events` or any
  other lab's schema) seeded with a small fixed 5-SKU catalog rather than
  a generated one, so no `@faker-js/faker` dependency was added for this
  lab (a deliberate, documented deviation - see Lab 20's README
  "Architecture"), 21 a fresh, minimal commerce-adjacent `products` table
  (id/public_id/name/price_cents only - deliberately not SPEC.md 8.2's
  full commerce model, same scoping rationale as Lab 16's
  `orders`/`outbox_events`; see Lab 21's README "Architecture"), seeded
  via the EXISTING `generateProducts` in
  `packages/data-generators/src/commerce.ts` (only `name`/`unitPriceCents`
  are carried over - `sku`/`category` are dropped since this schema has no
  columns for them), no new generator added. Lab 21 is also the first lab
  to add Redis (`redis:7-alpine`) alongside Postgres+PGweb in its
  `docker-compose.yml`, per CLAUDE.md's explicit "Redis for caching/
  distributed-lock labs" allowance - Redis connection handling
  (`createRedisClient`/`waitForRedis`) is a small helper LOCAL to Lab 21
  (`src/cache/redis-client.ts`), not a new shared package, since no second
  consumer exists yet (see that file's doc comment for the reasoning and
  the note that Lab 22 is a natural future promotion point), 22 a fresh,
  standalone `resource_state` table (id/public_id/name/fencing_token/
  last_writer/updated_at) - again not one of SPEC.md 8.2's five named
  domains, same "small standalone table, the lesson is the mechanism"
  rationale as Lab 06's `counters`/Lab 11's `documents`; also adds a
  Redis service alongside Postgres/PGweb (`redis:7-alpine`, host port
  6422), independent of Lab 21's own, separate Redis usage, 23 a fresh,
  minimal standalone `widgets` table (id/public_id/name/value) - not one
  of SPEC.md 8.2's five named domains, same "small standalone table, the
  lesson is the mechanism, not the data model" rationale as Lab 06's
  `counters`/Lab 11's `documents`/Lab 15's `payments`/Lab 19's
  `notifications`; seeded with Faker called directly in `src/seed/seed.ts`,
  same reasoning as Labs 16/19. This lab is also the first to add
  PgBouncer (`edoburu/pgbouncer`, two instances - one per pool mode, see
  its README "Architecture" for why one instance can't do both) as one of
  CLAUDE.md's explicitly-permitted pieces of additional infrastructure
  beyond Postgres/PGweb, 24 a fresh, standalone `widgets` table
  (id/public_id/name/value/updated_at) - again not one of SPEC.md 8.2's
  five named domains, same "small standalone table, the lesson is the
  mechanism" rationale as Lab 06's `counters`/Lab 11's `documents`/Lab 22's
  `resource_state`. Lab 24 is also the first lab in this repository with
  a genuine two-Postgres-node topology (`primary` + `replica`, physical
  streaming replication), and the first to use `bitnami/postgresql`
  instead of `postgres:16-alpine` on BOTH nodes specifically because this
  lab's subject is replication setup itself - see the lab's README
  "Architecture" for the full rationale and the bitnami-tag-availability
  caveat (only `latest`, currently PostgreSQL 18.6, is pullable without a
  paid subscription as of 2025), 25 commerce-adjacent, a fresh,
  independent `products` table (id/public_id/name/category/price_cents/
  stock_quantity/updated_at) reusing the shape of the EXISTING
  `generateProducts` generator in `packages/data-generators/src/commerce.ts`
  - `name`/`category`/`unitPriceCents` carry over as `name`/`category`/
  `priceCents`, `sku` is dropped (no column for it here), the same
  partial-reuse pattern Lab 21 established for its own `products` table;
  `stock_quantity` is generated separately via its own seeded Faker
  instance (offset `seed + 1000`) since `generateProducts` has no opinion
  about it. Reuses Lab 24's two-node `bitnami/postgresql` primary/replica
  topology verbatim (own Compose project name/network/volumes/ports/
  database - no shared state with Lab 24), 29 commerce-adjacent, a fresh,
  independent `customers` table (id/public_id/full_name/
  display_name/email/country) reusing the shape of the EXISTING
  `generateCustomers` generator in `packages/data-generators/src/commerce.ts`
  - not imported from Lab 03/04's own `customers` table, per the
  independent-labs principle; `display_name` is added by this lab's own
  migration 0001, not present in the shared generator's output.
- Lab 25 adds no new shared-package code either - it reuses `@labs/db-utils`'s
  `createPool`/`waitForDatabase` and `@labs/data-generators`'s EXISTING
  `generateProducts` as-is (the same generator Lab 21 already partially
  reuses independently), and its `src/router/` module (`classify.ts`,
  `router.ts`, `lsn-wait.ts`) is a small, lab-local abstraction, not a
  shared package, since no other lab needs primary/replica routing yet - a
  natural promotion candidate once Lab 26+ needs the same `classify`/
  `createRouter` shape. No changes were made to `packages/`, so no other
  lab needed re-validation.
- Lab 29 adds no new shared-package code and made no changes under
  `packages/` - it reuses the EXISTING `generateCustomers` generator as-is,
  so no other lab needed re-validation. The dangerous rename in
  `naive-rename-breaks-old-code.ts` deliberately runs against a throwaway
  `customers_naive_demo` copy (created and left behind by the script, not
  cleaned up automatically) rather than the real `customers` table, so this
  lab's own seed data, other scenarios, and tests stay repeatable across
  reruns - see that lab's README "Architecture" table for the full
  Drizzle-tracked-migration-vs-raw-SQL design rationale.
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
- Lab 22 adds no new shared-package code (`src/redis-lock/redis-client.ts`
  is a small, lab-local Redis connection helper, not a shared package,
  since no other lab depended on Redis before this one and Lab 21's
  concurrent, independent Redis usage does not share any code with Lab
  22's) - no changes were made to `packages/`, so no other lab needed
  re-validation.
- Lab 24 adds no new shared-package code either (`@labs/db-utils`'s
  existing `createPool`/`waitForDatabase` are reused as-is for BOTH the
  primary and replica connections - `src/db/primary-client.ts` and
  `src/db/replica-client.ts` are the only new client modules, one per
  node) - no changes were made to `packages/`, so no other lab needed
  re-validation. `src/db/migrate.ts` and `drizzle.config.ts` point only at
  `PRIMARY_DATABASE_URL`; the replica never runs its own migration, per the
  lab's own point that a physical standby receives its schema via WAL
  replay, not a second `drizzle-kit` run.
