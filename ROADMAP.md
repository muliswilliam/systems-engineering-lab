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

New with Lab 38: a lab that runs its own in-process HTTP service (not
containerized, same as every other lab's `pnpm dev`) uses host port `4NN`
for that service. A lab that adds a real Prometheus container uses `9NN`
for it; a lab that adds Grafana (none yet) would use `3NN`, following the
same pattern.

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
- [x] 26 - replication-lag-and-read-after-write - a real, independent two-node `bitnami/postgresql` primary/replica topology (own docker-compose.yml/ports/volumes, no shared state with Lab 24/25) reproducing the read-after-write bug end to end - `POST /profile` writes a new `display_name` on the primary, an immediate unguarded `SELECT` on the replica (naive scenario) came back stale on a real, repeated, captured 20/20 trials (100% stale rate) under a genuine 400ms `recovery_min_apply_delay` (the same real Postgres standby feature Lab 24 uses, not a fake sleep) - then three concrete mitigation strategies, each measured against the same real induced lag: Strategy A (read-your-writes routed to the primary) scored 20/20 correct regardless of lag, plus a second part that deliberately used a too-short 250ms sticky window against the real 400ms delay and reproduced the strategy's own documented limitation (a stale read even after the window "expired"); Strategy B (LSN-gated read - capture `pg_current_wal_lsn()` at write time, poll the replica's `pg_last_wal_replay_lsn()` until it catches up) measured a real average wait of 403.2ms under the 400ms delay and 0.4ms with no delay, 15/15 correct in both cases, proving the wait adapts to genuine replication state rather than a guessed constant; Strategy C (bounded staleness via `pg_stat_replication`) triggered its primary-fallback on 15/15 trials under real induced lag and 0/15 trials once the delay was removed, both with 15/15 correct reads - this lab's own validation run surfaced a real, worth-documenting gotcha along the way: `pg_stat_replication.replay_lag` (the interval column) badly under-reports lag while `recovery_min_apply_delay` is actively withholding replay confirmation (measured climbing 0.86ms -> 51ms across a 50ms-wide trial window that should have shown ~400ms), so Strategy C routes on the byte-based `pg_wal_lsn_diff` backlog instead, which reacted correctly and immediately. Full `docker compose down -v` -> `up -d` reset cycle re-confirmed real streaming replication (`pg_stat_replication` showing exactly one `streaming` replica) and all 9 Vitest integration tests passed identically before and after the reset, across 3 repeated full-suite runs with zero flakes. Domain: a fresh, standalone `user_profiles` table (id/public_id/display_name/bio/updated_at) mirroring SPEC.md's own Lab 26 profile-edit scenario directly - not one of SPEC.md 8.2's five named domains, same "small standalone table, the lesson is the mechanism" rationale as Lab 06's `counters`/Lab 24's `widgets`. Ports 5426/8426 (primary), 5526/8526 (replica).
- [x] 27 - cascading-replicas - a genuine THREE-node `bitnami/postgresql` chain, `primary -> replica-1 -> replica-2`, where replica-2's `POSTGRESQL_MASTER_HOST` points at replica-1 (not the primary), confirmed via real `pg_stat_replication` queried separately at all three tiers (primary: exactly one row, `application_name: "walreceiver"`, `state: "streaming"`; replica-1's OWN `pg_stat_replication`: a separate one row showing replica-2 connected to IT; replica-2's own: zero rows, a leaf) - proving the primary's fan-out never grows past one connection no matter how many leaf replicas exist further down the chain; real captured propagation-lag numbers across three phases (`cascading-lag.ts`): baseline no-delay (10 writes, avg hop-1 1.91ms / avg total 2.41ms), a real `recovery_min_apply_delay` of 150ms configured on BOTH replica-1 AND replica-2 (8 writes, avg hop-1 154.53ms / avg total 155.90ms - a genuinely surprising real result documented in the README's "Break it": the two delays do NOT stack to ~300ms, because `recovery_min_apply_delay` is anchored to the WAL record's ORIGINAL commit timestamp on the primary, not to each hop's own receipt time), and a third phase isolating the extra hop's cost cleanly by delaying ONLY replica-2 (8 writes, avg hop-1 4.13ms / avg total 154.38ms / avg additional-hop 150.25ms, landing almost exactly on the configured delay); the operational-consequence scenario (`upstream-failure.ts`) genuinely stops the `lab27-replica-1` Docker container via the real `docker` CLI (not simulated), writes to the primary while it is down, confirms via a real 3-second observation window that replica-2 does NOT receive that write (`visibleOnReplica2: false`, and the primary's own `pg_stat_replication` drops to zero rows during the outage), then restarts replica-1 and confirms replica-2 catches up automatically with no manual intervention beyond restarting the middle tier, and that both `pg_stat_replication` views are fully restored. Along the way this lab surfaced and worked around a real `bitnami/postgresql` limitation undocumented elsewhere in this repository: the image only appends a `host replication ...` `pg_hba.conf` entry for nodes in `master` mode, never for `slave` nodes, so replica-2's initial `pg_basebackup` against replica-1 failed with a real captured `FATAL: no pg_hba.conf entry for replication connection` error until replica-1 was given a custom `pg_hba.conf` (identical to a master node's) via bitnami's own `POSTGRESQL_MOUNTED_CONF_DIR`/`POSTGRESQL_USE_CUSTOM_PGHBA_INITIALIZATION` extension point - see `config/replica1-pg_hba.conf` and the README's "Architecture" section. 9 Vitest integration tests across 3 files passed (including a 19-second test that performs a real `docker stop`/`docker start` of replica-1), and a full `docker compose down -v` -> `up -d` reset cycle re-confirmed the cascade topology identically (`pg_stat_replication` at both the primary and replica-1 tiers) plus all three PGweb instances reachable (HTTP 200) and the seed script idempotent (20 rows on both runs). Domain: a fresh, minimal standalone `widgets` table (id/public_id/name/value/updated_at) - not one of SPEC.md 8.2's five named domains, same "small standalone table, the lesson is the mechanism" rationale as Lab 06's `counters`/Lab 24's `widgets`/Lab 26's `user_profiles`. Ports 5427/8427 (primary), 5527/8527 (replica-1), 5627/8627 (replica-2).
- [x] 28 - failover-and-role-changes - a real, independent two-node `bitnami/postgresql` primary/replica topology (own docker-compose.yml/ports/volumes, no shared state with Lab 24/25/26/27) demonstrating a genuine, un-simulated failover end to end: `docker compose stop primary` (a real container stop, not a mock) measured at 10,239.13ms - Docker's own SIGTERM-then-grace-period shutdown, explicitly documented as NOT representative of an instant real crash - followed by a real `SELECT pg_promote(true, 60)` call against the replica (Postgres 12+'s SQL-callable promotion function, not the older trigger-file mechanism) measured at 110.81ms, after which `pg_is_in_recovery()` on that node genuinely flipped from `true` to `false` and the exact same INSERT statement that had just been rejected with a real captured `SQLSTATE 25006` against the still-a-standby node succeeded outright against the newly-promoted one; the real, honestly measured write-unavailability gap - from the moment the primary was confirmed stopped to the moment a write succeeded anywhere in the cluster - was 124.51ms, almost entirely `pg_promote()`'s own duration, explicitly called out in the README as a best-case number with zero human/tooling decision latency built in, not a production SLO estimate. A companion `scenario:split-brain` script (precondition: run the failover scenario first) naively restarts the old, stopped primary container exactly as an under-informed operator might, and captures the real risk this lab's brief requires: both nodes independently report `pg_is_in_recovery() = false` (both believe they are primary), and each accepts a genuinely different write the other will never see (`written-to-OLD-primary-after-naive-restart` vs. `written-to-PROMOTED-node-independently`) - real, observed data divergence, not a thought experiment - with the README explaining (not implementing, per this lab's explicit scope) that `pg_rewind` or a fresh base backup, not a simple restart, is what safely reintroducing that node would require. Two Vitest integration test files (5 tests total, `fileParallelism: false` since one file genuinely stops a container and must never run interleaved with another against the same cluster) passed in a real captured 32.95s run, with the destructive `failover-promotion.test.ts` file itself performing a full real `docker compose down -v && up -d` reset in its own `afterAll` so the topology is fresh, healthy, and non-promoted again regardless of which order Vitest happens to discover the two files in (observed, in this lab's own validation run, to NOT be alphabetical - `failover-promotion.test.ts` actually ran before `baseline-replication.test.ts`, which is why both files' `beforeAll`s are written to be order-independent rather than relying on file-discovery order). A manually-driven full `docker compose down -v` -> `up -d` -> `db:migrate` -> `seed` cycle separately re-confirmed a fresh, healthy, non-promoted primary/replica pair (`pg_is_in_recovery()`: primary `f` / replica `t`) and both PGweb instances reachable (HTTP 200 on 8428/8528); seed confirmed idempotent (20 widgets on both of two consecutive runs) and `pnpm typecheck` passed with zero errors. Domain: a fresh, independent `widgets` table (id/public_id/name/value/updated_at) - not one of SPEC.md 8.2's five named domains, same "small standalone table, the lesson is the mechanism" rationale as Lab 24's own `widgets`/Lab 26's `user_profiles`. Ports 5428/8428 (primary), 5528/8528 (replica).

## Phase 7 - Safe Schema Evolution

- [x] 29 - safe-schema-migrations - a real, reproduced production incident (`ALTER TABLE ... RENAME COLUMN full_name TO display_name` against a throwaway copy of the table, then old application code's `SELECT full_name` fails immediately with a real captured SQLSTATE `42703`, "column \"full_name\" does not exist") vs. the expand/contract fix walked through as four genuinely distinct phases against the real `customers` table: (a) `ALTER TABLE ADD COLUMN display_name text` (nullable, no default) measured at 1.19ms regardless of table size; (b) a dual-write insert/update path that sets both columns together; (c) a batched, resumable backfill (200-row batches, 500 seeded rows backfilled in exactly 3 batches of 200/200/100, resumability proven by seeding a sentinel value a rerun must not overwrite); (d) a read-path switch proven correct for both a pre-existing (backfilled) row and a newly dual-written row in the same pass. Also covers a real measured contrast between a plain `CREATE INDEX` (blocked 1957ms behind a 2000ms-held write-locking transaction - the full duration) and `CREATE INDEX CONCURRENTLY` against the identical setup (an unrelated third-party write succeeded in 3ms while the concurrent build was still in flight, never blocked), plus `lock_timeout` (a real measured 1454ms indefinite block with no `lock_timeout` set vs. a real captured SQLSTATE `55P03`, "canceling statement due to lock timeout," failing in 507ms against a 500ms budget for the identical held lock). Domain: commerce-adjacent, a fresh, independent `customers` table (reusing the shape of the existing `generateCustomers` generator) - not imported from Lab 03/04's own `customers` table. Ports 5429/8429.
- [x] 30 - large-table-backfills - a single unbatched `UPDATE orders SET loyalty_points = ... WHERE loyalty_points IS NULL` against a real 1,000,000-row table (took 5,456ms/5,595ms across two separate captured runs) blocked an ordinary, completely unrelated concurrent write to the exact same row for 97.3%/97.4% of that entire duration (5,309ms and 5,449ms respectively) - a real measured incident, not a theoretical one, since Postgres holds every row lock a statement takes until the WHOLE statement's transaction commits, not just while that row is being processed; a batched, resumable, rate-limited fix (1,000-row batches, 50ms pacing sleep between batches, `WHERE loyalty_points IS NULL` as the natural resumability predicate) backfilled the identical 1,000,000 rows in 64,214ms (slower in total - a deliberate, documented tradeoff) while an ordinary concurrent write to the same row measured across 303 samples over the whole run stayed at p50 10.81ms/p99 20.95ms/max 66.66ms against a 7.57ms baseline - roughly 80x less worst-case impact than the naive approach for the identical workload; resumability was proven with a REAL `SIGKILL` (not a caught exception) to a genuinely separate OS process mid-run (killed after committing 1,800 of 20,000 rows across 9 batches), then resuming the identical function in-process completed the remaining 18,200 rows in 159ms with the invariant `1,800 + 18,200 = 20,000` holding exactly - zero rows double-processed, zero skipped, zero left `NULL`; a real, documented implementation pitfall surfaced along the way and is called out in the README - spawning the child via `pnpm exec tsx ...` interposes a wrapper process that itself spawns a separate Node process, so `SIGKILL` to the wrapper left the real backfill process running as an undetected orphan, silently defeating the demo, until the spawn was changed to run `node --import tsx/esm <script>` directly (exactly one pid). A partial index (`idx_orders_loyalty_points_pending ON orders (id) WHERE loyalty_points IS NULL`) keeps the batched backfill's own selection query fast as the pending cohort shrinks. Domain: a fresh, standalone `orders` table (id/public_id/customer_email/amount_cents/status/created_at/loyalty_points) - not SPEC.md 8.2's full commerce model and not imported from Lab 16's or Lab 20's own `orders` tables, same "small standalone table, the lesson is the mechanism" rationale as Lab 06's `counters`/Lab 23's `widgets`; seeded via a local, batched/streamed (`unnest`-driven multi-row INSERT, 5,000 rows/batch) Faker generator directly in `src/seed/seed.ts` (no `@labs/data-generators` addition, same reasoning as Labs 16/19/23), supporting `--size=small\|medium\|large` (20,000/200,000/1,000,000 rows, seeded in 185ms/1.6s/8.6s respectively) and `--rows=N`. Ports 5430/8430.

## Phase 8 - PostgreSQL Operations and Performance

- [x] 31 - vacuum-autovacuum-and-bloat - 15 full-table `UPDATE` passes over a real 50,000-row table with `autovacuum_enabled = false` set on that table only grew it from a real measured 5.09MB to 80.86MB (15.87x) while `SELECT COUNT(*)` still correctly reported 50,000 live rows the entire time (`n_dead_tup` climbed to 748,276, matching 15 x 50,000 tuple versions); cloning the table's current live rows into a freshly-written `page_views_fresh` and running the identical `EXPLAIN (ANALYZE, BUFFERS) SELECT COUNT(*)` against both showed the bloated table touching 10,350 buffers against the fresh table's 704 - a real 14.7x more pages read for the identical logical result. The fix, both forms, real and measured: plain `VACUUM` dropped `n_dead_tup` from 1,596,808 to 15 while `pg_relation_size` stayed at exactly 169.75MB (unchanged, since plain VACUUM marks space reusable rather than returning it to the OS) with 15 concurrent probe connections seeing a worst-case latency of only 24.81ms against its own 143.37ms duration; `VACUUM FULL` against the identical table genuinely shrank the file to 8.16MB (a real 20.79x reduction) but the same concurrent-write probes saw a worst case of 101.7ms against an 89.77ms `VACUUM FULL` duration (`vacuumFullBlockRatio: 1.133`) - a write queued when the `ACCESS EXCLUSIVE` lock was grabbed waited for essentially the entire operation. A separate, fully deterministic test (not wall-clock racing) proved the underlying lock-conflict mechanism directly: a transaction holding nothing but a `SELECT`'s `AccessShareLock` produced a real SQLSTATE `55P03` lock-timeout against a concurrent `VACUUM FULL` after ~150ms, while the identical held lock did not block a concurrent plain `VACUUM` at all. Autovacuum itself was proven to actually run, not just assumed: with `autovacuum_vacuum_scale_factor = 0`/`autovacuum_vacuum_threshold = 50` set per-table and `autovacuum_naptime = 2s` set instance-wide (this lab's own dedicated Postgres only), `pg_stat_user_tables.autovacuum_count` advanced from 0 to 1 and `n_dead_tup` dropped from 5,000 to 0 within a real measured 2.02 seconds, with zero `VACUUM` command run by hand. 7 tests across 4 files passed in a real captured 3.1-4.5s run across multiple full runs; a complete `docker compose down -v` -> `up -d` -> migrate -> seed -> test cycle was re-verified working, PGweb confirmed reachable (HTTP 200), and seeding confirmed idempotent (identical 5,000-row count across two consecutive `pnpm seed` runs). A real PostgreSQL observability gotcha was discovered and documented along the way: a single backend only flushes its own pending `pg_stat_user_tables` report at most once per ~1 second, so hammering many UPDATEs through one long-lived, reused connection left this lab's own dead/live tuple readings stale (briefly showing `n_live_tup` at double the real row count during development) - fixed by running every mutating statement on its own short-lived, explicitly-closed connection, plus an explicit `pg_stat_reset_single_table_counters` call right after each reseed's `TRUNCATE` for a synchronous, guaranteed-clean baseline. Domain: a fresh, standalone `page_views` table (id/public_id/slug/view_count/updated_at) - not one of SPEC.md 8.2's five named domains, same "small standalone table, the lesson is the mechanism" rationale as Lab 06's `counters`/Lab 30's `orders`; deliberately not Lab 06's own `counters` table despite the surface similarity, since this lab needs table-scale churn (thousands of rows, many passes) rather than single-tuple-scale `pageinspect` mechanics. Ports 5431/8431.
- [x] 32 - deadlocks-and-lock-debugging - two `pg.Client` transactions, each locking its own "from" account first via `SELECT ... FOR UPDATE` then requesting the other's ("A locks 1 then wants 2, B locks 2 then wants 1"), synchronized via an explicit two-party `Promise` rendezvous (not a sleep) so both sides are guaranteed to have taken their first lock before either requests its second - reproduced a REAL, Postgres-detected deadlock identically across 5 repeated runs during validation, capturing Postgres's own SQLSTATE `40P01` error including its real `detail` field ("Process 155 waits for ShareLock on transaction 756; blocked by process 156. Process 156 waits for ShareLock on transaction 757; blocked by process 155."), not a simulated timeout. Diagnosed the live wait-for cycle with a `pg_locks`/`pg_stat_activity` query polled via `wait_event_type = 'Lock'` (no fixed sleep) and adapted directly from the EXISTING `packages/db-utils/sql/show-blocked-queries.sql` - no new shared SQL file was needed, since that same "who's blocking whom" query, run while both sides are genuinely waiting, already returns the exact two edges that form a 2-cycle. The fix - consistent lock ordering (`Math.min`/`Math.max` of the two account ids, regardless of transfer direction) replacing "from-account-first" - was measured at 0 deadlocks across 100 concurrent independent trial pairs (`100/100` naive deadlocks vs `0/100` ordered deadlocks, real captured run of `scenario:trials --trials=100`; the automated test suite's own smaller 40-trial-per-strategy run reproduced the identical `40/40` vs `0/40` result), with total account balances conserved in every trial under both strategies. A complementary retry-on-deadlock scenario showed the SAME naive lock order still deadlocking on attempt 1 (`totalDeadlocksObserved: 1`) before both legs eventually committed on retry - explicitly documented in the README as RECOVERY, not PREVENTION, and explicitly distinguished from Lab 09's Serializable-retry loop (a completely different failure class - SSI's dangerous-dependency detection under concurrent reads, not a lock-ordering cycle - that happens to share the same catch/backoff/retry code shape). A real bug surfaced during this lab's own validation is documented in `consistent-lock-ordering.ts`'s doc comment: an early version reused the naive scenario's synchronization barrier for the ordered fix too, which hung indefinitely, because that barrier assumes both legs' first lock is on a DIFFERENT row (true for naive ordering) - under consistent ordering both legs' first lock is the SAME row by design, so one side's first `SELECT ... FOR UPDATE` blocks on a real Postgres lock before it can ever reach the rendezvous point, deadlocking the SCRIPT itself rather than Postgres; the fix removes the barrier entirely for the ordered strategy, relying on ordinary Postgres lock contention alone. 10 tests across 4 files passed in a real captured 3.86-3.97s run across multiple repeated full-suite runs with zero flakes; a complete `docker compose down -v` -> `up -d` -> migrate -> seed -> test cycle was re-verified working, PGweb confirmed reachable (HTTP 200), and seeding confirmed idempotent (identical 302-row count across two consecutive `pnpm seed` runs). Domain: banking/ledger, a fresh, independent `accounts` table (id/public_id/owner_name/balance_cents/created_at) - the same minimal single-table shape Labs 05/07/08/10/18 each define independently, per the independent-labs principle; no `transfers`/audit table, since this lab's subject is `pg_locks`/`pg_stat_activity` state and Postgres's own SQLSTATE, not application bookkeeping. Ports 5432/8432 (this lab's literal `54NN`-convention assignment collides with a locally-installed Postgres on many developer machines, including the one used for this lab's own validation, which needed `POSTGRES_PORT=5532` to run - `.env.example` and the README's "Setup" section both document the override explicitly).
- [x] 33 - query-tuning-and-explain-analyze - four genuinely distinct slow-query patterns against a real 199,895-order / 601,142-order_line dataset (`--seed=42 --size=large`, seeded in ~24s), every EXPLAIN captured via `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` rather than text-regex parsing: Pattern 1 bad row estimates, two distinct causes - stale statistics (a real bulk `UPDATE` recategorized 50,000 orders to `'cancelled'`, pushing the true fraction from 7.98% to 33.00% while `idx_orders_status`'s pre-existing stats still said 8%, producing a real captured 3.32x estimate-vs-actual divergence that `ANALYZE` alone corrected to 0.99x in 56ms) and correlated columns (`orders.channel` deliberately correlated with `status` at the data level - 88.3% of cancelled orders are `channel = 'phone'` by construction - producing a real captured 2.96x independence-assumption undercount for `status = 'cancelled' AND channel = 'phone'` that `CREATE STATISTICS ... (dependencies, mcv)` corrected to 0.99x, `ANALYZE` alone provably could not fix it); Pattern 2 a missing-index 3-table JOIN (paid orders in a 7-day window joined to customers + order_lines) where two new indexes turned a 36.084ms Hash-Join-plus-double-Seq-Scan into a 20.206ms Nested-Loop-plus-Index-Scan plan - a real, deliberately reported non-monotonic result where total buffer touches went UP (8,995 -> 11,327, +26%) while wall-clock time still dropped 44%, used to teach that sequential and random I/O are not equally expensive per buffer; Pattern 3 a non-sargable `date_trunc('month', placed_at AT TIME ZONE 'UTC') = ?` reporting query (14.239ms, 17.2x row-estimate undercount) fixed two ways - an expression index (4.496ms, ~3.2x faster) and a preferred sargable range rewrite reusing the SAME plain `placed_at` index Pattern 2 and Pattern 4 also need (3.334ms, ~4.3x faster, no new single-purpose index) - plus a real captured gotcha where `CREATE INDEX` alone did NOT fix the row estimate until an explicit `ANALYZE` ran afterward; Pattern 4 `ORDER BY placed_at DESC LIMIT 20` with no supporting index forcing a full Seq-Scan-plus-Sort (18.167ms, 2,309 buffers) fixed by a plain B-tree index eliminating the Sort node entirely (0.083ms, 23 buffers - a real ~219x speedup and ~100x fewer buffers). Real write-amplification measured for the combined 4 indexes: 554ms/108,295 rows-per-sec with 0 present vs. 614ms/97,787 rows-per-sec with all 4 present (~11% slower, ~10% lower throughput) for an identical 20,000-order/~40,000-order_line insert batch. Two real, worth-documenting implementation bugs surfaced and fixed during this lab's own development: (1) Postgres's per-node `Buffers` counters in JSON-format EXPLAIN output are CUMULATIVE (a parent node's count already includes every descendant's), so naively summing every node's buffer count over-counted a real query's total usage by ~7x (61,231 summed vs. 8,995 actual) until fixed to read only the root node's count; (2) node-pg parses a Postgres `timestamp without time zone` value using the HOST's local timezone rather than UTC, which silently corrupted a month-boundary calculation on this lab's own (UTC+3) build host until fixed by doing all date arithmetic in SQL and passing pre-formatted, explicitly-UTC-suffixed text as query parameters instead of round-tripping through JS `Date` objects. 13 Vitest integration tests across 2 files (index usability/correctness for all 4 indexes, plus estimate-divergence-improves invariants for both Pattern 1 sub-cases) passed in a real captured ~1.5s run against a fresh small seed. A full `docker compose down -v` -> `up -d` -> migrate -> seed -> test cycle was re-verified working, PGweb confirmed reachable (HTTP 200), and seeding confirmed idempotent (identical 909-order count across two consecutive `pnpm seed --size=small` runs). Domain: commerce, reused in SHAPE from Lab 03/04 (`customers`/`products`/`orders`/`order_lines`, a fresh independent copy, not imported) plus one new locally-generated column (`orders.channel`) not part of the shared `@labs/data-generators` commerce generators. Ports 5433/8433.
- [x] 34 - pagination-at-scale - against a real, freshly seeded 600,000-row `activity_events` table (seeded in a real measured 12.5s at ~48,000 rows/sec via streamed/batched inserts), the naive `ORDER BY created_at, id LIMIT 20 OFFSET N` query's real median `EXPLAIN (ANALYZE, BUFFERS)` execution time over 5 runs per depth grew from 0.017ms (`OFFSET 0`) to 0.174ms (`OFFSET 2,000`) to 1.48ms (`OFFSET 20,000`) to 8.153ms (`OFFSET 100,000`) to 28.702ms (`OFFSET 400,000`) - a real measured 1,688x slowdown from page 1 to page 20,001 - with `sharedBuffersTouched` (a deterministic, non-flaky companion metric) growing from 8 to 13,144 buffers in near-exact proportion, even though every single depth's plan used the SAME `Index Scan` on a `(created_at, id)` B-tree index under a `Limit` node: the index avoids a sort but cannot avoid walking-and-discarding every row before the offset, since OFFSET is a statement about position, not a value the index stores. The keyset/cursor fix (`WHERE (created_at, id) > (cursor) ORDER BY created_at, id LIMIT 20`) measured at the identical depths stayed real-flat: median execution time between 0.011ms and 0.017ms and `sharedBuffersTouched` at exactly 8 buffers at every single depth from `OFFSET 0` through `OFFSET 400,000`, because the same index lets Postgres seek directly to the cursor's B-tree position (O(log n)) regardless of how deep it is. The correctness bug was reproduced concretely, not asserted: inserting one real row with a `created_at` before the entire table's minimum caused a verified real duplicate (page 2's first row, fetched at the client's next naive `OFFSET`, came back with the exact same `public_id` already delivered as page 1's last row); deleting one real row from inside the already-delivered page caused a verified real skip (the row that would have been page 2's first row was captured before the mutation and proven absent from both page 1 and the post-mutation page 2). The same two mutations replayed against keyset pagination produced zero duplication and zero skip (`page2Unchanged: true` both times, real captured output), and a third scenario proved keyset's one honest, documented limitation: a new row inserted AFTER the cursor with a tuple value sorting within the next page's remaining range DOES appear in that page (`newRowAppeared: true`) - not a bug, since keyset reads live state rather than a frozen snapshot, but a real, precisely-scoped caveat the README states explicitly rather than overselling keyset as a perfect fix. A `COUNT(*)` cost scenario measured an unfiltered `COUNT(*)` over the 600k-row table at a real 22.195ms and a filtered `COUNT(*)` at 14.802ms, against a single keyset page fetch's 0.018ms (a 1,233x ratio) - real evidence for why infinite-scroll UIs that never render a total page count avoid paying this cost. 11 tests across 4 files passed in a real captured ~3.4s run (invariant test: 50 sequential keyset pages, 1,000 rows, zero duplicates and an exact match against the canonical `ORDER BY` query fetched directly); a complete `docker compose down -v` -> `up -d` -> migrate -> seed -> typecheck -> test cycle was re-verified working, PGweb confirmed reachable (HTTP 200), and seeding confirmed idempotent (identical 20,000-row count across two consecutive default `pnpm seed` runs). Domain: a fresh, standalone `activity_events` table (id/public_id/actor_name/action/target_type/target_id/created_at) modeling a dev-collaboration-platform audit feed (e.g. "alice merged pull_request #4821") - not one of SPEC.md 8.2's five named domains, same "small standalone table, the lesson is the mechanism" rationale as Lab 23's `widgets`/Lab 30's `orders`/Lab 31's `page_views`; `created_at` is deliberately generated at whole-second granularity via a seeded Poisson-ish random walk (mean 2s interarrival, ~39% of consecutive events tying on the same second) specifically so `(created_at, id)` tuple ordering is a real, load-bearing necessity in this dataset rather than a contrived edge case. Ports 5434/8434.
- [x] 35 - partitioning - the SAME logical dataset (a 300-device IoT telemetry fleet, 5 weighted metrics, all of calendar year 2025) seeded in lockstep into both an unpartitioned `metric_events_flat` and a `PARTITION BY RANGE (recorded_at)` `metric_events_partitioned` (12 monthly partitions), at a real measured `--size=large` of 1,200,000 rows per table (2,400,000 total, seeded in a real measured ~24.7s at ~97,000 rows/sec via streamed/batched inserts into both tables). A real "last 7 days" query (`WHERE recorded_at >= ... AND recorded_at < ...`, a 7-day window entirely inside June) measured via `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, median of 5 runs: 25.769ms/54,552 buffers against the flat table with NO index (naive seq scan) -> 5.256ms/46,806 buffers once a plain B-tree index on `recorded_at` was added (a real 4.9x speedup that is an INDEXING win, honestly attributed, not a partitioning win) -> 3.373ms/**2,502 buffers** against the partitioned table, with the plan's own `relationsScanned` field proving REAL partition pruning (`["metric_events_y2025m06"]`, 1 of 12 partitions touched) - an 18.7x buffer reduction over the indexed-but-unpartitioned table, the real, honestly-isolated partitioning-specific win. A query spanning the June/July boundary correctly pruned to exactly the 2 overlapping partitions, not 1 and not all 12. The dishonest-if-omitted counter-example was measured just as carefully: an all-time "average reading for one device" query with NO filter on the partition key touched ALL 12 partitions (zero pruning possible) and touched MORE total buffers than the flat table (68,225 vs 54,552) despite landing at a similar wall-clock time (22.818ms vs 26.334ms) - real, captured evidence that partitioning is not a universal speedup, only a speedup for queries that can be range-restricted by the partition key. Point 3's operational payoff was measured at three real scales to show the underlying mechanism, not just one ratio: purging January's data via `ALTER TABLE ... DETACH PARTITION` + `DROP TABLE` (a near-constant catalog operation, 4.892-7.058ms measured across all three scales) against the semantically equivalent `DELETE FROM metric_events_flat WHERE recorded_at >= ... AND recorded_at < ...` on the flat table (5.879ms at 5,000 rows, 24.253ms at 50,000 rows, 68.225ms at 100,000 rows) - DETACH+DROP was actually SLOWER at 5,000 rows (0.8x, its fixed overhead dominating at tiny scale, an honest and pedagogically useful crossover) before pulling ahead to 4.4x at 50,000 rows and a real 13.9-14.0x at 100,000 rows, real evidence that the gap is structural (flat, catalog-cost vs. row-proportional cost) and grows in partitioning's favor as row counts grow. Point 4 reproduced a REAL captured Postgres error (SQLSTATE `23514`, `'no partition of relation "metric_events_partitioned" found for row'`) for a January-2026-dated insert against a table deliberately provisioned only through December 2025 with no `DEFAULT` partition, fixed by provisioning the missing partition ahead of the data (`CREATE TABLE metric_events_y2026m01 PARTITION OF ...`) and verified by the identical insert then succeeding - plus a second, proactive provisioning of February 2026 with no failed insert forcing it, demonstrating the healthy "ahead of the data" operational pattern a scheduled job should follow rather than the reactive fix. Point 5 (optional, included) contrasted RANGE with `PARTITION BY LIST (region)` on a small standalone `metric_events_by_region` table (us/eu/apac), reproducing the identical `23514` failure class for an unlisted `'latam'` region and fixing it with a genuinely different mechanism - `CREATE TABLE ... PARTITION OF ... DEFAULT` - then confirming a literal `region = 'us'` filter still pruned to exactly 1 partition even with the DEFAULT partition present (Postgres can prove DEFAULT cannot hold a value with its own explicit partition). Two real, empirically-verified Postgres partitioning rules are documented directly in the schema/migration comments, not asserted from memory: a `PRIMARY KEY`/`UNIQUE` constraint on a partitioned table must include the partition key (`metric_events_partitioned`'s key is `(id, recorded_at)`, and `public_id` has only a plain index, not `UNIQUE`, unlike the flat table's real `UNIQUE(public_id)`), and an index created on the parent BEFORE a partition exists is automatically inherited by every partition created afterward via `CREATE TABLE ... PARTITION OF` (verified directly against this lab's own Postgres 16 instance) - the reason this lab's migration creates the parent's `recorded_at` index immediately after the parent table, before any of the 12 monthly partitions. `metric_events_partitioned` and `metric_events_by_region` are deliberately NOT declared as Drizzle `pgTable()` schema objects (only the flat table is) - `drizzle-kit`'s schema-diffing has no vocabulary for `PARTITION BY`/`PARTITION OF`/`ATTACH`/`DETACH PARTITION`, so both partitioned tables' DDL lives entirely in hand-authored `drizzle-kit generate --custom` raw-SQL migrations, addressed at runtime via raw `pg` queries rather than Drizzle's query builder, per CLAUDE.md's "ORM plus SQL" principle. 11 Vitest integration tests across 3 files passed in a real captured ~18-19s run (partition-pruning structural assertions on `relationsScanned`; a real timing assertion that DETACH+DROP is at least 2x faster than the equivalent DELETE at 50,000 rows/month; real captured-error assertions for both the RANGE and LIST missing-partition failure, `code: "23514"`, and their fixes) with zero flakes across multiple repeated runs; a complete `docker compose down -v` -> `up -d` -> migrate -> seed -> typecheck -> test cycle was re-verified working, PGweb confirmed reachable (HTTP 200), and seeding confirmed idempotent (every `pnpm seed` run reconciles both partitioned tables back to their canonical as-migrated partition layout first, undoing whatever a previous scenario run detached/dropped/attached, before truncating and reseeding - identical 60,000-row-per-table count across two consecutive default `pnpm seed` runs). Domain: IoT device telemetry (`metric_events_flat`/`metric_events_partitioned`: device_id/metric/value/recorded_at) - one of SPEC.md Lab 35's own named example domains ("events/logs/metrics"), not one of section 8.2's five general-purpose domains; a fresh, independent schema sharing no code or state with any other lab's tables, per the independent-labs principle. Ports 5435/8435.

## Phase 9 - Reliability Engineering

- [x] 36 - rate-limiting-and-backpressure - framed deliberately at the APPLICATION layer, not Postgres-connection exhaustion (Lab 23's own subject, referenced rather than re-derived): a naive, unprotected endpoint forwarding every request straight to a real, in-process, finite-capacity, timeout-enforcing `BoundedResource` (capacity 10, 250ms latency, 1000ms acquire timeout - standing in for a slow downstream like a payment gateway) produced a real captured `succeeded: 40, failed: 160` out of 200 concurrent requests, exactly matching the theoretical max servable within the timeout budget, with real captured `Error` objects ("downstream acquire timed out after 1000ms..."), not simulated slowness. Two Redis-backed rate limiters, each a single atomic Lua script (per CLAUDE.md's "prefer datastore-native guarantees" applied to a counter instead of a row): token bucket (capacity 100, refill 100/sec) and sliding window log (window 1000ms, limit 100) both measured the EXACT `allowed: 100, rejected: 20` split from a 120-concurrent-request burst in 5ms, real and reproducible on every rerun (the exactness comes from Lua-script atomicity, not timing luck) - the literal "120 requests in 1 second against a 100/sec limit" scenario the task brief asked for. A bounded, Postgres-backed job queue (reusing Lab 14's `SELECT ... FOR UPDATE SKIP LOCKED` claiming pattern for consumption, capacity enforced via a Lab-11-style conditional `UPDATE queue_state SET pending_count = pending_count + 1 WHERE pending_count < capacity`) measured Phase 1's real `accepted: 20, rejected: 180` from a 200-concurrent-attempt burst against an idle capacity-20 queue, and Phase 2's real `maxObservedPendingCount: 20` held across 79 live-polled samples during 2 seconds of sustained pressure (`phase2Accepted: 62, phase2Rejected: 3016, processedByWorker: 82`) - contrasted against a naive unbounded in-process array queue that accepted all 5,000 pushed tasks with zero rejections and grew real, measured heap usage by 24.95MB (5,000 tasks * ~5KB of genuinely distinct `crypto.randomBytes`-sourced payload each - an earlier draft using `"x".repeat(n)` measured almost no heap growth at all, a real, documented gotcha: V8 represents a single-repeated-character string far more cheaply than realistic distinct payloads, understating the effect until random content was used instead), still 4,643-deep after a 2-second observation window with only 357 of 5,000 tasks drained. A dedicated "distinction" scenario proved rate limiting and backpressure are not substitutes: 20 requests sent at a generous 50/sec rate-limit budget produced `rateLimited: 0` (zero rejections - plenty of headroom) while a downstream with only 3 concurrent slots and 800ms latency still produced a real captured `downstreamTimedOut: 17` - the same 20 requests. This lab's own real, worth-documenting implementation bug, caught by its own validation run rather than assumed away: the bounded queue's original `enqueue` held one Postgres client checked out via `pool.connect()` and, on the capacity-full path, called `pool.query()` (a SECOND connection request from the same pool) before releasing the first - under the 200-concurrent-attempt Phase 1 burst this genuinely deadlocked the pool (every client checked out and waiting for a second one that would never come, ironic for a lab about protecting a service from overload); the fix re-uses the already-checked-out client for the fallback read instead of asking the pool for another one, documented in `bounded-queue.ts`'s own comment. 9 Vitest integration tests across 5 files passed in a real captured ~2.3s run (rate limiters use fixed, explicit timestamps rather than real sleeps for deterministic refill/window-expiry assertions, per CLAUDE.md's "assert invariants, not timing"); a complete `docker compose down -v` -> `up -d` -> migrate -> seed -> typecheck -> test cycle was re-verified working, PGweb confirmed reachable (HTTP 200), Redis confirmed healthy (`PONG`), and seeding confirmed idempotent (identical clear-and-reset state across two consecutive `pnpm seed` runs). No `--size`/`--rows` seed flags - this lab has no bulk realistic dataset, only generic protect-the-service mechanisms, per its own scoping (see README "Architecture"). Ports 5436/8436 (Postgres/PGweb, needed for the bounded job queue's real, durable, `SKIP LOCKED`-claimed capacity gate), Redis 6436 (needed for the two rate limiters' atomic Lua-script counters) - the first lab since 21/22 to combine Postgres+PGweb+Redis in one `docker-compose.yml`, deliberately: the two mechanisms have different natural homes (Redis for a tiny, extremely-high-frequency, non-durable counter; Postgres for "hand out work exactly once and never lose it") and this lab does not force either mechanism into the other's role (see README "Architecture" and "Tradeoffs" for why a Redis-backed queue or a Postgres-backed rate limiter would be a worse fit here).
- [x] 37 - retries-timeouts-and-circuit-breakers - a pure in-process TypeScript lab (no Docker Compose, no database - see the lab's README "Architecture" for why: retries/timeouts/circuit-breakers are client-side concerns, not datastore concerns) built around a real, seeded (`mulberry32`), deterministic-but-realistic `UnreliableDownstream` class with four health modes (`healthy`/`degraded`/`down-fail-fast`/`down-hang`) rather than a canned mock. The naive scenario reproduced two REAL, measured problems: a caller with no timeout blocked for `5002ms` against a downstream configured to hang for `5000ms` (`scenario:naive-hang`), and 50 concurrent callers each retrying up to 5 times with no backoff against a fully-down downstream produced exactly `250` real downstream calls in `124ms` wall clock (`scenario:retry-storm`, asserted as an exact count - not an approximation - in `tests/integration/retry-storm.test.ts`), with every one of those 250 calls failing anyway (zero successful requests bought for a 5x load multiplier). Adding `withTimeout(fn, 200)` against the identical 5000ms-hanging downstream measured a real p50/p99/max caller-observed latency of `202.0ms/203.0ms/203.0ms` - a real ~25x reduction in worst-case latency - while the README explicitly documents the caveat that `Promise.race` bounds only the CALLER's wait, not the downstream's own continued work (the abandoned 5000ms timer keeps running server-side, exactly the gap the idempotency scenario exploits). Exponential-backoff-with-full-jitter (`delay = random(0, min(maxDelayMs, baseDelayMs * 2^(attempt-1)))`) retried a downstream that failed 3 times then recovered, capturing real growing-but-non-identical delays of `7.3ms, 140.7ms, 361.1ms` across 3 attempts (ceiling doubling 100->200->400ms, actual delay randomized within each), and a companion sub-scenario proved a `NonTransientDownstreamError` is retried exactly 0 additional times (`ACTUAL downstream calls made: 1`) even with 4 attempts still available, making the "transient only" distinction a real, asserted behavior rather than a description. The idempotency scenario built a real, reproducible double-effect bug distinct from Lab 15's: `UnreliableDownstream.charge()` commits its ledger write immediately but delays its response 400-900ms, so a caller's own (reasonable) 150ms timeout raced ahead of a call that was already succeeding server-side - the naive retry (no reused key) produced a real captured `downstream ledger total: 2000 cents` / `charges applied downstream: 2` for one intended 1000-cent charge, while reusing a single idempotency key across the retry (the same mechanism Lab 15 implements with a Postgres `UNIQUE` constraint + `ON CONFLICT DO NOTHING`, here an in-process `Map` instead, with the README explicit that this substitution is fine pedagogically and NOT fine for production) kept the ledger at exactly `1000 cents`/`1` charge, with the retry's `chargeId` (`ch_1`) proven identical to the original. A real closed/open/half-open/closed-or-reopen `CircuitBreaker` state machine (injectable clock for deterministic unit tests, real cooldown sleeps in the scenario script) tripped OPEN on exactly the 5th consecutive failure (`downstream.totalCallCount` stayed at exactly `5` even after 8 total `execute()` calls - 3 were fast-failed), with a real measured latency contrast of `19-28ms` per call that actually reached the downstream vs. `0ms` (not merely fast - literally sub-millisecond, since OPEN never attempts the downstream at all) for every call after tripping; a HALF_OPEN probe after the real 300ms cooldown elapsed closed the breaker on success (exactly 1 downstream call made by the probe) and, in a second run, reopened it on a failed probe - every transition captured as a real structured Pino log line (`{"from":"CLOSED","to":"OPEN","reason":"failure threshold reached","consecutiveFailures":5}` etc.), not simulated. A composed scenario layered all three mechanisms in the order the README argues for - circuit breaker outermost, `retryWithBackoff` inside `breaker.execute()`, `withTimeout` inside each individual retry attempt - and measured the concrete payoff of that ordering during a sustained outage: the breaker tripped after exactly 4 FAILED `execute()` calls (each containing up to 3 internal retry attempts) rather than after 4 raw downstream failures, and once OPEN, 2 further `execute()` calls made ZERO downstream calls each, for a real total of `12` downstream calls made vs. the `18` a caller with no breaker at all would have made for the same 6 logical requests - a real, measured 33% reduction that grows without bound the longer an outage lasts. 31 tests across 7 files (4 unit, 3 integration) passed in a real captured ~5.6s run, `pnpm typecheck` passed with zero errors, and every one of the 7 `pnpm scenario:*` scripts plus `pnpm dev` was run directly and its real captured output verified during this lab's own validation - no Docker reset cycle applies (see "Architecture" for why). No new `@labs/*` shared-package code was added.

## Phase 10 - Observability and Security

- [x] 38 - observability - a small real HTTP service (Node's own `http` module, no framework) backed by a fresh, standalone `orders` lookup table, instrumented with all three observability pillars for real and tied together into one connected incident, not four disconnected demos. **Structured logging**: the identical 300-request real traffic run, logged both as structured Pino ndjson and as three deliberately inconsistent free-text formats (a stand-in for three engineers' diverging `console.log` calls); a real `JSON.parse`+group-by aggregation over the structured file computed EXACT real numbers (`/orders/:id: total=288, errorRate=9.7%, p50=1.86ms, p95=308.84ms, p99=311.24ms`; overall `300 completed, 28 errors, 9.33%`), while a single reasonable regex against the free-text file recovered only `100 of 300 lines (33%)` and could not express outcome at all for the lines it did match. **Metrics**: a real `prom-client` registry (`http_requests_total` Counter, `http_request_duration_seconds` Histogram, `http_requests_in_flight` Gauge, `http_errors_total` Counter, plus real `pg.Pool`-sourced `db_pool_total_clients`/`db_pool_idle_clients`/`db_pool_waiting_clients` gauges - the last one a real, literal "queue depth," not a metaphor) exposed at a real `/metrics` endpoint; scraping it via a real HTTP GET after 250 real requests summed `http_requests_total` back to exactly `250`, and a real, deployed `prom/prometheus` container (`docker-compose.yml`, scraping `pnpm dev`'s live process via `host.docker.internal`) reported real `up{job="lab38-observability-service"} == 1` via Prometheus's own query API during this lab's own validation - Grafana was deliberately not added (see README "Why a real Prometheus container, and no Grafana" for the scope tradeoff). **Correlation IDs**: 5 requests fired CONCURRENTLY, each with its own `x-request-id`, produced 27 real interleaved log lines; filtering by one target ID recovered exactly that request's own 5-line path (`request.start` -> `db.query.start`/`db.query.end` -> `business_logic.start` -> `request.complete` with a real captured `err.message="Cannot read properties of null (reading 'split')"`), with zero lines from the other 4 concurrent requests mixed in. **Postgres inspection**: `packages/db-utils/sql`'s existing scripts, reused unmodified (not duplicated), run against REAL concurrent activity this lab generated itself - a real long-running `pg_sleep(6)` transaction, a real `SELECT ... FOR UPDATE` lock holder, and a real blocked `UPDATE` writer - with `show-blocked-queries.sql` correctly pairing the real blocked PID to its real blocking PID, and `show-active-transactions.sql` correctly showing the `pg_sleep`-backed query still running. **Tied together**: a `scenario:debug-narrative` walk (300 requests) used structured logs to find `28 errors (9.7%)` and one slow outlier, a correlation ID to prove the error's own database query succeeded normally (failure was application-only), `/metrics` to confirm `http_errors_total{route="/orders/:id"}=28` matched exactly (SYSTEMIC, not a fluke), and a live `pg_stat_activity` sample to show 5 real `pg_sleep`-backed backends during a slow burst (database IS a contributing cause) vs. 0 non-idle backends during an error burst (database is NOT a contributing cause of the errors) - the same four tools, in the same order, a real on-call engineer would use. The lab's own real bug (`business-logic.ts`'s unguarded `order.customerEmail!.split("@")` against ~5% seeded guest-checkout rows with `customer_email IS NULL`) was verified fixable with a real one-line change during this lab's own validation (errors dropped from 28 to 0) and then deliberately reverted, since the bug's presence is what the shipped lab's own tests and every captured number above depend on - the same reasoning Lab 10/12's naive code paths stay in their repos permanently. 10 Vitest integration tests across 5 files passed in a real captured ~28-30s run (exact metric-counter-vs-real-traffic assertions, exact structured-log-vs-traffic-mix assertions, a real blocked-query PID-pairing assertion, seed determinism); `pnpm typecheck` passed with zero errors; a complete `docker compose down -v` -> `up -d` -> migrate -> seed (idempotent: `400` rows/`20` guest-checkout both times) -> typecheck -> test cycle was re-verified working, and PGweb confirmed reachable (HTTP 200). Domain: see "Domains by lab" below. Ports 5438/8438 (Postgres/PGweb), `4438` (the lab's own HTTP service, a new port convention this lab establishes - see the port-convention header above), `9438` (Prometheus).
- [x] 39 - row-level-security-and-db-security - a genuinely multi-tenant "shared schema, tenant_id column" SaaS domain (`tenants` + `support_tickets`, 40 seeded tenants x 2,500 tickets = 100,000 rows in a real measured ~3.1-3.3s, idempotent across repeated `pnpm seed` runs) protected by FOUR real, distinct Postgres roles this lab creates itself (`sql/000-bootstrap-roles.sql`, run exactly once by Postgres's own docker-bootstrap superuser `lab39_admin` at container init via `docker-entrypoint-initdb.d` - the real chicken-and-egg fix, since neither the migration nor the application role is ever granted `CREATEROLE`): `lab39_migrator` (owns every table/function/policy this lab creates, DDL only, used only for `db:migrate`/`seed`), `lab39_app` (SELECT/INSERT/UPDATE/DELETE on data tables only, the everyday application connection), and `lab39_readonly` (SELECT only, also PGweb's own connection - confirmed via its own docker logs, "Connected to PostgreSQL 16.15"). THE BUG (`scenario:naive-leak`) reproduced two REAL cross-tenant leaks against a real `lab39_app` connection with Row-Level Security deliberately disabled (`ALTER TABLE ... DISABLE ROW LEVEL SECURITY`, run only by the owning migrator role and always restored in a `finally` block even if an assertion throws): a forgotten `WHERE tenant_id = ?` clause returned a real captured `totalRowsReturned: 100000` / `distinctTenantIdsReturned: 40` / `rowsBelongingToOtherTenants: 97500` to a request scoped to a single tenant, and a syntactically-fine-but-WRONG-VALUE `WHERE tenant_id = <tenant B's real id>` clause returned exactly tenant B's real 2,500 rows to a tenant-A-scoped request - two genuinely different bug classes, both real, both captured. THE FIX (`scenario:rls-fix`) replayed the IDENTICAL two buggy queries (the same shared `buggy-queries.ts` functions - not corrected versions) against the same table with `ROW LEVEL SECURITY` enabled and a `tenant_isolation` policy keyed off a `current_tenant_id()` SQL function wrapping `current_setting('app.current_tenant_id', true)` (missing_ok=true, plus `nullif(..., '')`, so an unset session fails CLOSED rather than erroring or matching every row) and measured a real `rowsBelongingToOtherTenants: 0` / `rowsReturned: 0` for both bugs, plus a third real check that a session with NO tenant context set at all also sees 0 rows, not every tenant's rows. LEAST PRIVILEGE (`scenario:least-privilege`) captured 8 real SQLSTATE `42501` errors, one per attempted out-of-scope operation: `lab39_readonly` INSERT/UPDATE/DELETE ("permission denied for table support_tickets"), `lab39_app` CREATE TABLE ("permission denied for schema public") / DROP TABLE / ALTER TABLE ADD COLUMN ("must be owner of table support_tickets") / an RLS `WITH CHECK` violation from inserting a row claiming a different tenant than its own session's ("new row violates row-level security policy for table \"support_tickets\""), and `lab39_migrator` attempting `CREATE ROLE` / `ALTER ROLE ... SUPERUSER` ("permission denied to create/alter role") - real proof it cannot self-escalate despite owning every table it created. THE OWNER/BYPASSRLS GOTCHA (`scenario:owner-bypass`) demonstrated, concretely rather than merely documented, that `lab39_migrator` (table owner, NOT superuser, NOT BYPASSRLS - real captured `rolsuper: false, rolbypassrls: false` straight from `pg_roles`) and `lab39_admin` (superuser) both saw a real `total: 100000, distinct_tenants: 40` with NO tenant session set at all, while the byte-for-byte identical query as `lab39_app` (not owner, not BYPASSRLS) returned a real `total: 0` - because this lab's migration 0001 deliberately does NOT set `FORCE ROW LEVEL SECURITY`, the documented real-world default misconfiguration this lab exists to make concrete rather than just warn about. PERFORMANCE (`scenario:performance`, median of 5 `EXPLAIN (ANALYZE, BUFFERS)` runs per invocation) measured REAL, IDENTICAL shared-buffer counts (89-90 hit blocks, always equal within a given invocation) between RLS-on and RLS-off against the same indexed `tenant_id` equality query - Postgres's planner folds `tenant_id = $1 AND tenant_id = current_tenant_id()` into one `Index Cond` plus a `STABLE`-function `One-Time Filter` evaluated once per statement rather than once per row - with wall-clock time consistently but noisily higher with RLS on across repeated runs (0.215-0.933ms vs 0.197-0.267ms without, honestly reported as an observed range rather than a single misleadingly-precise number, per CLAUDE.md's Documentation Quality standard). 13 Vitest integration tests across 4 files passed in a real captured ~746-840ms run (`fileParallelism: false`, since `naive-leak.test.ts` is the only file that toggles RLS off database-wide and always restores it in `afterEach` regardless of file-discovery order); a complete `docker compose down -v` -> `up -d` -> migrate -> seed -> typecheck -> test cycle was re-verified working twice during this lab's own validation, with real role/policy recreation reconfirmed each time (`\du` showing `lab39_admin` alone with Superuser/Bypass RLS attributes, `relrowsecurity = t` on both `tenants` and `support_tickets`), PGweb confirmed reachable (HTTP 200) and genuinely connected as `lab39_readonly` per its own container logs, and `pnpm typecheck` passing with zero errors both times. This lab's own real, worth-recording discovery, caught by its own validation run rather than assumed away: an initial `EXPLAIN (BUFFERS)` buffer-summing helper recursively summed every plan node's "Shared Hit Blocks" INCLUDING each node's children, double-counting every buffer touched below the plan's root - verified directly against this lab's own Postgres 16 instance (a two-table join's parent node reported `hit=91` while its two children reported `hit=1` and `hit=90`, i.e. the parent's own figure is already cumulative for its whole subtree, not exclusive to itself) - fixed by reading only the root node's own counters, after which the RLS-on/RLS-off buffer counts came back genuinely, provably identical instead of RLS appearing to double I/O cost it does not actually add. Domain: a fresh, independent SaaS-style helpdesk (`tenants` + `support_tickets`) - not one of SPEC.md 8.2's five named domains, chosen because an internal admin/debug ticket-listing view is a believable, realistic place for exactly the two leak classes this lab demonstrates. Ports 5439/8439 (single Postgres node) - the first lab in this repository to connect as FOUR distinct, real Postgres roles instead of one shared superuser, per CLAUDE.md's Security section.

## Phase 11 - Capstone

- [x] 40 - production-capstone - a genuinely working small ticketing/booking system (`events`/`seats`/`orders`/`outbox_events`/`notification_attempts`) composing five mechanisms taught standalone in earlier labs into one real, interacting pipeline: conditional-write seat reservation (Lab 11/12), a transaction spanning the order write + seat transition + outbox write (Lab 05/16), an idempotency key with `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING *` (Lab 15), `SELECT ... FOR UPDATE SKIP LOCKED` outbox claiming (Lab 14/17), and a circuit breaker (outermost) wrapping retry-with-backoff (inside) wrapping a per-attempt timeout (innermost) around a simulated notification downstream (Lab 37), plus a Redis token-bucket rate limiter at the checkout boundary (Lab 36). The system-level failure this capstone exists to demonstrate - one that neither Lab 15 nor Lab 37 alone would reproduce, since neither lab's own scenario combines a duplicate-order storm WITH a struggling downstream at the same time - was reproduced with real captured numbers: 20 concurrent duplicate checkout requests (modeling a client's HTTP layer retrying after a lost response, SPEC.md Lab 15's own motivating scenario) against a naive (no-idempotency) checkout handler produced a real `distinctOrdersInDb: 20`/`outboxEventsCreated: 20` for what should have been ONE purchase, and draining that outbox with a naive (no-breaker) worker against a `degraded` notification downstream made a real `notificationCallsMade: 45` to attempt notifying one customer 20 separate times, over a real `drainDurationMs: 9318`. The identical 20-way duplicate storm replayed against the composed/fixed system (idempotent checkout + protected worker), this time against a strictly harder fully-`down` downstream so the breaker's own contribution stays separately measurable, produced a real `newlyCreated: 1`/`duplicatesSuppressed: 19`/`distinctOrdersForStormSeat: 1` (idempotency's contribution, measured independently of the breaker) and, of 27 total outbox claim attempts across all events created in that run (the 1 storm event plus 8 from genuinely distinct concurrent legitimate customers), only `notificationCallsMade: 9` real calls ever reached the struggling downstream while `circuitOpenRejections: 24` were rejected locally in ~0ms once the breaker tripped OPEN (the breaker's contribution, measured independently of idempotency). A dedicated cross-cutting invariant test composes all of this into one assertion no single earlier lab's own test suite could express: 50 concurrent duplicate checkouts against a fully-down downstream still produce exactly 1 order, exactly 1 outbox event, and at most 9 real downstream calls (bounded by `maxAttempts=3` x up to 3 reclaim cycles) - a number that would be IDENTICAL whether 5 or 5,000 duplicates had arrived, because idempotency collapses them to one logical unit of work before the breaker's own bound ever comes into play. Two supporting scenarios reused earlier labs' own invariant-style assertions at capstone scale: a 100-concurrent-attempt seat-reservation race correctly produced exactly 1 `reserved`/99 `rejected` (Lab 12's mechanism), and a 120-request burst against a 100-capacity Redis token-bucket limiter produced the exact `allowed: 100, rejected: 20` split in 5ms (Lab 36's mechanism, reused fresh). 7 Vitest tests across 5 files passed in a real captured ~2.4s run; `pnpm typecheck` passed with zero errors; a complete `docker compose down -v` -> `up -d` -> migrate -> seed -> test cycle was re-verified working twice, PGweb confirmed reachable (HTTP 200), Redis confirmed healthy (`PONG`), and seeding confirmed idempotent (1 event/30 seats across two consecutive `pnpm seed` runs). Domain: a small ticketing/booking platform - deliberately not SPEC.md 8.2's full venue/section/inventory/payments model, since this capstone's lesson is composing mechanisms correctly, not modeling a rich domain; a fresh, independent schema sharing no code or state with any other lab, per the independent-labs principle (each composed mechanism is reimplemented fresh here from its own lab's CONCEPT, never imported). Ports 5440/8440 (Postgres/PGweb), Redis 6440, a hand-rolled Prometheus-text `/metrics` endpoint on 9440 (`pnpm dev`) - deliberately NOT `prom-client` or Lab 38's own metrics approach (a sibling, independently-built lab as of this writing), per the independent-labs principle and CLAUDE.md's "Dependencies" guidance to avoid a dependency for ~60 lines of counter/gauge logic whose mechanics this lab wants visible, not hidden.
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
  database - no shared state with Lab 24), 26 a fresh, standalone `user_profiles`
  table (id/public_id/display_name/bio/updated_at) - again not one of
  SPEC.md 8.2's five named domains, same "small standalone table, the
  lesson is the mechanism" rationale as Lab 06's `counters`/Lab 24's
  `widgets`; this table mirrors SPEC.md's own Lab 26 "POST /profile" example
  directly rather than being a generic placeholder. Lab 26 is its own,
  fully independent second two-Postgres-node topology (own
  docker-compose.yml/ports/volumes/database, no shared Docker network or
  state with Lab 24's or Lab 25's), reusing the SAME `bitnami/postgresql`
  primary/replica SHAPE Lab 24 established (for the same reasons) but built
  fresh rather than imported, per the independent-labs principle, 27 a
  fresh, standalone `widgets` table (id/public_id/name/value/updated_at) -
  again not one of SPEC.md 8.2's five named domains, same "small standalone
  table, the lesson is the mechanism" rationale as Lab 06's `counters`/
  Lab 24's `widgets`/Lab 26's `user_profiles`. Lab 27 is this repository's
  first genuine THREE-Postgres-node topology - `primary -> replica-1 ->
  replica-2`, with replica-2 streaming from replica-1 rather than from the
  primary - built as its own fully independent chain (own
  docker-compose.yml/ports/volumes/database, no shared Docker network or
  state with Labs 24/25/26), reusing the same `bitnami/postgresql` shape for
  the same reasons Lab 24 documents. Lab 27 also surfaced a real
  `bitnami/postgresql` limitation none of the two-node replication labs
  needed to work around: the image's entrypoint only grants a `pg_hba.conf`
  replication entry to nodes in `master` mode, so a `slave`-mode middle
  tier (replica-1) has no `pg_hba.conf` entry permitting a THIRD node to
  stream from it - fixed with a custom `pg_hba.conf` mounted at replica-1
  via bitnami's own `POSTGRESQL_MOUNTED_CONF_DIR`/
  `POSTGRESQL_USE_CUSTOM_PGHBA_INITIALIZATION` extension point (see
  `labs/27-cascading-replicas/config/replica1-pg_hba.conf`), 28 a
  fresh, independent `widgets` table (id/public_id/name/value/updated_at) -
  again not one of SPEC.md 8.2's five named domains, same "small standalone
  table, the lesson is the mechanism" rationale as Lab 24's own `widgets`/
  Lab 26's `user_profiles`; defined only in Lab 28's own schema, not shared
  with Lab 24's `widgets` despite the identical shape, per the
  independent-labs principle. Lab 28 is its own fourth fully independent
  two-Postgres-node `bitnami/postgresql` primary/replica topology (own
  docker-compose.yml/ports/volumes/database, no shared state with Lab 24's,
  25's, 26's, or 27's), and is the first lab in this repository to add real
  Docker container lifecycle control (`docker compose stop`/`start`, via a
  new lab-local `src/lib/docker-control.ts`) driven directly from its own
  scenario scripts and one of its two Vitest test files, since this lab's
  subject - an unplanned primary outage and a real `pg_promote()` call -
  cannot be honestly demonstrated any other way, 29
  commerce-adjacent, a fresh,
  independent `customers` table (id/public_id/full_name/
  display_name/email/country) reusing the shape of the EXISTING
  `generateCustomers` generator in `packages/data-generators/src/commerce.ts`
  - not imported from Lab 03/04's own `customers` table, per the
  independent-labs principle; `display_name` is added by this lab's own
  migration 0001, not present in the shared generator's output, 31 a fresh,
  standalone `page_views` table (id/public_id/slug/view_count/updated_at) -
  again not one of SPEC.md 8.2's five named domains, same "small standalone
  table, the lesson is the mechanism" rationale as Lab 06's `counters`/
  Lab 30's `orders`; deliberately built as its own schema rather than
  reusing Lab 06's `counters` table despite the surface similarity, since
  Lab 31 needs table-scale UPDATE churn (thousands of rows, many full-table
  passes) to make physical size and `pg_stat_user_tables` dead-tuple counts
  measurable, where Lab 06 deliberately uses a single hand-picked row for
  `pageinspect`-level tuple-version inspection, 32 banking/ledger, a fresh,
  independent `accounts` table (id/public_id/owner_name/balance_cents/
  created_at) - the SAME minimal single-table shape Labs 05/07/08/10/18 each
  define independently for their own concurrency concept, per the
  independent-labs principle (none of those six `accounts` tables are
  shared or imported across labs); no `transfers`/audit table, since this
  lab's subject (deadlock formation and diagnosis) is entirely `pg_locks`/
  `pg_stat_activity` state and Postgres's own SQLSTATE `40P01`, not
  application-level bookkeeping, unlike Lab 05's `transfers` or Lab 20's
  `saga_log`, 33 commerce, reused in SHAPE
  from Lab 03/04 (`customers`/`products`/`orders`/`order_lines`, a fresh
  independent copy per the independent-labs principle, not imported from
  either lab) seeded via the EXISTING `generateCustomers`/`generateProducts`/
  `generateOrdersBatched` generators in
  `packages/data-generators/src/commerce.ts` as-is, plus one new column
  (`orders.channel`) generated LOCALLY in this lab's own `src/seed/seed.ts`
  (via a small `src/seed/generate-channel.ts` helper, deliberately correlated
  with `status` at the data level - Pattern 1b's whole point) rather than
  added to the shared generator, since no other lab needs it, 34 a fresh, standalone
  `activity_events` table (id/public_id/actor_name/action/target_type/
  target_id/created_at) modeling a dev-collaboration-platform audit feed
  (e.g. "alice merged pull_request #4821") - again not one of SPEC.md 8.2's
  five named domains, same "small standalone table, the lesson is the
  mechanism" rationale as Lab 23's `widgets`/Lab 30's `orders`/Lab 31's
  `page_views`; `created_at` is deliberately generated at whole-second
  granularity via a seeded Poisson-ish random walk (mean 2s interarrival,
  ~39% of consecutive events tying on the same second) specifically so
  `(created_at, id)` tuple ordering is a real, load-bearing necessity for a
  stable sort order in this dataset, not a contrived edge case, 35 IoT
  device telemetry (`metric_events_flat`/`metric_events_partitioned`:
  device_id/metric/value/recorded_at, seeded across a 300-device pool and 5
  weighted metrics) - one of SPEC.md Lab 35's own named example domains
  ("events/logs/metrics"), not one of section 8.2's five general-purpose
  domains; plus a small standalone `metric_events_by_region` (region/
  device_id/metric/value/recorded_at) for the optional LIST-partitioning
  contrast. A fresh, independent schema sharing no code or state with any
  other lab's tables, per the independent-labs principle, 36 a fresh,
  standalone domain modeling the "protect the service" MECHANISM directly
  rather than a business domain (`jobs` + `queue_state` + `rate_limit_events`)
  - not one of SPEC.md 8.2's five named domains, and deliberately not a rich
  business domain at all, since this lab's own subject (per its README
  "Architecture") is rate limiting and backpressure as generic mechanisms;
  `jobs` reuses Lab 14's `FOR UPDATE SKIP LOCKED` claiming shape for
  consumption only (no `attempts`/`locked_until` - Lab 36 does not re-derive
  Lab 14's retry/lease machinery), and `queue_state`'s single-row capacity
  gate applies Lab 11's conditional-write idiom to a capacity check instead
  of a version column. Also the first lab since 21/22 to combine
  Postgres+PGweb+Redis in one `docker-compose.yml`, deliberately: Redis backs
  the two rate limiters' atomic Lua-script counters (a natural fit per
  CLAUDE.md's "Redis for caching/distributed-lock labs" allowance, extended
  here to rate-limiting counters) while Postgres backs the bounded job
  queue's durable, exactly-once-claimed capacity gate - neither mechanism is
  forced into the other's role (see the lab's own README "Tradeoffs" for why
  a Redis-backed queue or a Postgres-backed rate limiter would be a worse fit
  here), 37: no relational domain at all - a pure in-process
  TypeScript lab with no Postgres, Redis, or Docker Compose, since
  retries/timeouts/circuit-breakers are client-side behavioral concerns, not
  datastore concerns (see the lab's own README "Architecture" for the full
  reasoning). Its one stand-in domain object is a seeded, deterministic,
  in-process `UnreliableDownstream` class (four `health` modes -
  `healthy`/`degraded`/`down-fail-fast`/`down-hang` - plus a `charge()`
  method modeling a payment-processor-style call whose ledger write commits
  before its slow response is sent), not a database table - flavor text for
  a generic "downstream API call," per the task's own framing, rather than
  one of SPEC.md 8.2's five named domains, 38 a fresh, standalone `orders`
  table (id/public_id/customer_email/amount_cents/status/created_at) - not
  Lab 03/04's commerce-schema `orders` and not Lab 20's saga-oriented
  `orders`, same "small standalone table, the lesson is the mechanism"
  rationale as Lab 06's `counters`/Lab 31's `page_views`, since this lab's
  subject is the observability TOOLING (structured logs, metrics,
  correlation IDs, Postgres inspection) rather than a rich order domain.
  `customer_email` is nullable specifically to model a real "guest
  checkout" edge case: this lab's own `business-logic.ts` derives an email
  domain from it without a null check, a real, reproducible bug (not an
  injected fake exception) that is this lab's entire "error" traffic
  bucket and the incident its debug-narrative scenario diagnoses, 39 a
  fresh, independent SaaS-style helpdesk domain (`tenants` +
  `support_tickets`) - not one of SPEC.md 8.2's five named domains, chosen
  because an internal admin/debug ticket-listing view is a believable,
  realistic place for exactly the two leak classes (a forgotten tenant
  filter, and a syntactically-fine-but-wrong-value one) this lab
  demonstrates; also the first lab in this repository to connect as FOUR
  distinct, real Postgres roles
  (`lab39_admin`/`lab39_migrator`/`lab39_app`/`lab39_readonly`) instead of
  one shared superuser, per CLAUDE.md's Security section.
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
- Lab 26 adds no new shared-package code (same `@labs/db-utils`
  `createPool`/`waitForDatabase` reuse as Lab 24) - no changes were made to
  `packages/`, so no other lab needed re-validation. It does add one new
  lab-local module, `src/lib/replication-control.ts`, holding the
  `setReplicaApplyDelay`/`getPrimaryWalLsn`/`waitForReplicaLsnAtLeast`/
  `getReplicationLagFromPrimary`/`waitForReplicationCaughtUp` primitives
  every scenario and test in this lab shares - kept lab-local rather than
  promoted to a shared package since Lab 27/28 (this repository's other
  planned replication labs) may need a different shape of these primitives
  once cascading replicas and failover are in play, and no second consumer
  exists yet to justify generalizing now.
- Lab 27 adds no new shared-package code (same `@labs/db-utils`
  `createPool`/`waitForDatabase` reuse as Lab 24/26) - no changes were made
  to `packages/`, so no other lab needed re-validation. It adds two new
  lab-local modules: its own `src/lib/replication-control.ts` (a fresh copy
  in the same spirit as Lab 26's, not imported from it per the
  independent-labs principle, generalized to expose a
  `getDownstreamReplicationStats` query since a cascading topology needs
  "what does THIS node see below itself" at multiple tiers, not just "what
  does the primary see") and `src/lib/docker-control.ts` (a small
  `stop`/`start`/`waitForContainerHealthy` wrapper around the real `docker`
  CLI, used only by the upstream-failure scenario/test to genuinely stop
  and restart the `lab27-replica-1` container - kept lab-local since Lab 28
  (failover) is the next candidate consumer but its exact needs aren't
  known yet).
- Lab 28 adds no new shared-package code and made no changes under
  `packages/`, so no other lab needed re-validation - it reuses the EXISTING
  `@labs/db-utils`/`@labs/logging` exports as-is, same as Lab 24/26. It adds
  two new lab-local modules instead: `src/lib/docker-control.ts` (real
  `docker compose stop`/`start`/`down -v && up -d` lifecycle control via
  `node:child_process`) and `src/lib/replication-control.ts` (a
  `pg_promote()`/`pg_is_in_recovery()`/connection-vs-SQL-level-failure-
  distinguishing set of primitives independent of, and a different shape
  from, Lab 26's own `replication-control.ts` written for lag/consistency
  strategies rather than failover) - both kept lab-local per the same
  reasoning Lab 26's note gives for its own `replication-control.ts`: no
  second consumer exists yet to justify a shared package, and Lab 27's
  cascading-replica needs turned out to want a different shape of these
  primitives.
- Lab 30 adds no new shared-package code and made no changes under
  `packages/`, so no other lab needed re-validation. `src/scenarios/
  write-prober.ts` (a shared "ordinary concurrent write latency"
  measurement helper used by all three of this lab's scenario scripts) is
  lab-local rather than promoted to `@labs/test-utils`, since its
  measurement technique - a fresh, short-lived `pg.Client` per attempt - is
  specific to this lab's "simulate a stream of independent application
  requests" scenario and has no second consumer yet.
- Lab 31 adds no new shared-package code and made no changes under
  `packages/`, so no other lab needed re-validation - `src/scenarios/
  write-prober.ts` and `create-bloat.ts` are rebuilt fresh and lab-local,
  same "no second consumer yet" reasoning as Lab 30's own copy. This lab's
  own real, worth-recording discovery: a single PostgreSQL backend only
  flushes its own pending `pg_stat_user_tables` report to shared memory at
  most once per ~1 second (and `TRUNCATE`'s stats reset goes through the
  same pipeline) - repeatedly UPDATEing a table through one long-lived,
  reused connection left `n_live_tup`/`n_dead_tup` readings stale and
  briefly showing `n_live_tup` at double the real row count during this
  lab's own development. The fix, used throughout every scenario and the
  seed script: run each mutating statement (`UPDATE`, `VACUUM`, `VACUUM
  FULL`, the seed's `TRUNCATE`+inserts, the query-performance comparison's
  `CREATE TABLE ... AS SELECT`) on its own short-lived connection and
  explicitly close it, which forces an immediate flush, plus an explicit
  `pg_stat_reset_single_table_counters` call right after `TRUNCATE` for a
  synchronous, guaranteed-clean baseline on every reseed. The interactive
  `scenario:vacuum` script also needed `startConcurrentWriteProbers` (many
  parallel probe connections rather than one sequential prober) to reliably
  catch `VACUUM FULL`'s sub-100ms `ACCESS EXCLUSIVE` window in this lab's
  container-local dataset sizes - a single sequential prober's own
  connect/query/disconnect overhead made it too coarse to reliably land a
  sample inside a lock window that short. The corresponding automated test
  instead proves the same lock-conflict mechanism deterministically (a held
  `AccessShareLock` plus `lock_timeout`, the same idiom Lab 29/30 use for
  their own lock-blocking proofs), independent of dataset size or timing
  luck.
- Lab 32 adds no new shared-package code - it reuses the EXISTING
  `generateAccounts` in `packages/data-generators/src/ledger.ts` as-is for
  its trial-pair accounts (same generator Labs 05/18 already use
  independently), so no other lab needed re-validation. It does not add a
  new file under `packages/db-utils/sql/` either: the diagnostic this lab
  needs (a live 2-transaction wait-for cycle) turned out to be exactly what
  the EXISTING `show-blocked-queries.sql` "who's blocking whom" query
  already returns once polled at the right moment (two edges, each waiting
  on the other) - a genuinely new "cycle detection" query was evaluated and
  found unnecessary for this lab's 2-transaction case, per CLAUDE.md's
  instruction to reuse/extend before adding. `src/lib/sync.ts`'s
  `createTwoPartyBarrier` (an explicit two-party `Promise` rendezvous, not a
  sleep) is a new, lab-local synchronization primitive - kept local rather
  than promoted to `@labs/test-utils` since no other lab yet needs a
  two-party rendezvous specifically (as opposed to `@labs/test-utils`'s
  existing `runConcurrently`, which fans out N independent tasks rather than
  synchronizing two cooperating ones).
- Lab 33 adds no new shared-package code and made no changes under
  `packages/`, so no other lab needed re-validation - it reuses the EXISTING
  `generateCustomers`/`generateProducts`/`generateOrdersBatched` generators
  in `packages/data-generators/src/commerce.ts` as-is (`orders.channel` is
  generated locally via a new lab-local `src/seed/generate-channel.ts`
  module, not added to the shared generator, since no other lab needs it).
  `src/scenarios/explain-json.ts` (`explainAnalyzeJson`) is this lab's own
  `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` parsing utility, a JSON-based
  successor to Lab 04's text-regex `explain-utils.ts` built specifically
  because this lab needs precise per-node `Plan Rows` vs `Actual Rows` and
  buffer counts rather than Lab 04's coarser scan-type detection - kept
  lab-local rather than promoted to a shared package since Lab 32
  (deadlocks-and-lock-debugging) and other later performance-adjacent labs
  may want a different shape of it and no second consumer exists yet. Two
  real implementation bugs were found and fixed during this lab's own
  validation, both documented in its README "Architecture": (1) Postgres's
  per-node JSON `Buffers` counters are cumulative (inclusive of every
  descendant node), not exclusive, so this lab's own first draft of
  `explainAnalyzeJson` over-counted total buffer usage by summing every
  node instead of reading only the root node's count; (2) node-pg parses a
  Postgres `timestamp without time zone` value using the host's LOCAL
  timezone rather than UTC, which silently corrupted a month-boundary
  calculation on this lab's own UTC+3 build host until fixed by doing all
  date arithmetic in SQL (`to_char`-formatted text) rather than round-
  tripping through JS `Date` objects - see `src/scenarios/sample-window.ts`.
- Lab 34 adds no new shared-package code and made no changes under
  `packages/`, so no other lab needed re-validation. `src/scenarios/
  pagination-lib.ts` (the shared OFFSET/keyset query + `EXPLAIN (ANALYZE,
  BUFFERS, FORMAT JSON)` parsing helpers used by all five of this lab's
  scenario scripts and all four test files) is lab-local rather than
  promoted to `@labs/db-utils`, same "no second consumer yet" reasoning as
  Lab 30/31's own lab-local helpers - though the JSON-plan parsing shape
  (recursively summing `Shared Hit Blocks`/`Shared Read Blocks` across plan
  nodes) is written generically enough that Lab 33
  (query-tuning-and-explain-analyze) may find it worth promoting if it needs
  the same buffer-accounting technique. `src/seed/generator.ts`'s
  Poisson-ish timestamp random walk (exponential interarrival via
  inverse-CDF sampling from a seeded `Faker` instance, truncated to whole
  seconds) is also lab-local - it exists specifically to produce realistic
  `created_at` ties at scale, which no other lab's domain currently needs.
- Lab 35 adds no new shared-package code and made no changes under
  `packages/`, so no other lab needed re-validation. `src/db/partitions.ts`
  (canonical partition-layout definitions, `pg_inherits`/`pg_class`
  inspection, and the `reconcileCanonicalPartitionLayout`/
  `resetListDemoTable` idempotent-reseed helpers) and `src/scenarios/
  partition-lib.ts` (the shared `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`
  parsing + timing helpers, including `relationsScanned` - the field this
  whole lab's pruning evidence rests on) are both lab-local rather than
  promoted to `@labs/db-utils`, same "no second consumer yet" reasoning as
  Lab 30/31/34's own lab-local helpers; the `pg_inherits`-based partition
  inspection query in particular is written generically enough that any
  future partitioning-adjacent lab could reuse it as-is. This is also the
  first lab where two tables are declared with the SAME row shape but only
  one (`metric_events_flat`) is a Drizzle `pgTable()` - the partitioned
  tables are addressed entirely via raw `pg` queries with hand-written
  TypeScript row interfaces, since `drizzle-kit`'s schema-diffing cannot
  express `PARTITION BY`/`PARTITION OF` and would fight hand-authored
  partition DDL on every future `db:generate` if declared as a pgTable()
  too - see the lab's own README "Architecture" section for the full
  reasoning.
- Lab 36 adds no new shared-package code and made no changes under
  `packages/`, so no other lab needed re-validation - it reuses the EXISTING
  `@labs/db-utils`/`@labs/logging`/`@labs/test-utils` exports as-is.
  `src/redis/redis-client.ts` is its own small, lab-local Redis connection
  helper (`createRedisClient`/`waitForRedis`), a fresh copy in the same
  spirit as Lab 21's and Lab 22's own independent copies, not imported from
  either per the independent-labs principle. This lab's own real,
  worth-recording discovery, caught by its own validation run rather than
  assumed away: `src/backpressure/bounded-queue.ts`'s `enqueue` originally
  held one Postgres client checked out via `pool.connect()` for its whole
  transaction, and on the capacity-full path called `pool.query()` (a
  SECOND, independent connection request from the same pool) for a fallback
  read before releasing the first - under this lab's own Phase 1 burst
  (200 concurrent `enqueue` calls against a capacity-20 queue, so the large
  majority take the capacity-full path) this genuinely deadlocked the
  connection pool: every client was checked out and waiting for a second
  one that could never arrive, since nothing was left in the pool to hand
  out. The fix re-uses the already-checked-out client for that fallback
  read instead of asking the pool for a second connection - see that
  function's own doc comment. A related, smaller finding also worth
  recording: the naive-backpressure memory-growth scenario originally used
  `"x".repeat(n)` to build each queued task's payload and measured almost no
  real heap growth for 5,000 tasks at 50KB each - V8 represents a
  single-repeated-character string far more cheaply than genuinely distinct
  payload content, which understated the real effect this scenario exists
  to demonstrate; switching to `crypto.randomBytes(...).toString("hex")` per
  task (so every payload is genuinely distinct, not deduplicatable in any
  way) produced the real, expected ~25MB heap growth for 5,000 tasks at
  ~5KB each instead.
- Lab 37 adds no new shared-package code and made no changes under
  `packages/`, so no other lab needed re-validation - it does not even
  depend on `@labs/db-utils` (no database exists in this lab at all). Its
  three library modules (`src/lib/timeout.ts`, `src/lib/retry.ts`,
  `src/lib/circuit-breaker.ts`) and its seeded `UnreliableDownstream`
  (`src/downstream/unreliable-downstream.ts`) are kept lab-local rather than
  promoted to a shared package, since no other lab currently needs
  timeout/retry/circuit-breaker primitives - a natural promotion candidate
  if a later lab (e.g. the Lab 40 capstone, which SPEC.md's own component
  list implies will call multiple real subsystems) needs the same shape.
  `@labs/test-utils`'s existing `runConcurrently` is reused as-is for the
  retry-storm scenario's 50 concurrent callers, the same helper Labs
  15/18/21 already use.
- Lab 38 adds no new shared-package code and made no changes under
  `packages/` - it reads `packages/db-utils/sql/*.sql` directly (a new
  `src/observability/db-sql.ts` loader resolves a plain monorepo-relative
  path rather than Node's package `exports` map, since that is simpler and
  does not depend on how `@labs/db-utils` happens to be linked into
  `node_modules`), which is the first time any lab actually runs those
  shared SQL scripts rather than just having them available. Its structured
  vs. free-text logger (`src/observability/request-logger.ts`) is
  deliberately lab-local rather than added to `@labs/logging`: it needs a
  second, durable ndjson-FILE output that every other lab does not, and
  adding that purely for one lab risked changing behavior other labs
  depend on. This lab is also the first to run its own in-process HTTP
  service and the first to add a real Prometheus container - both establish
  new port-convention entries (see the port-convention header) for any
  later lab that adds either.
- Lab 40 (production-capstone), domain: a small ticketing/booking platform
  (`events`/`seats`/`orders`/`outbox_events`/`notification_attempts`) - not
  one of SPEC.md 8.2's five general-purpose domains, deliberately smaller
  than SPEC.md 8.2's own full ticketing model, since this capstone's lesson
  is composing five mechanisms correctly (Labs 05/11/12/14/15/16/17/36/37),
  not modeling a rich domain. Every composed mechanism is a fresh,
  independent reimplementation of its own lab's CONCEPT (conditional-write
  reservation, transactional-outbox write, `SKIP LOCKED` claiming,
  idempotency-key `UNIQUE` constraint, timeout/retry/circuit-breaker,
  Redis token-bucket rate limiting) - none of it imports another lab's
  code, per the independent-labs principle. Lab 40 adds no new
  shared-package code and made no changes under `packages/`, so no other
  lab needed re-validation; it reuses `@labs/data-generators`/
  `@labs/db-utils`/`@labs/logging`/`@labs/test-utils` as-is. Its
  `src/lib/metrics.ts` is a deliberately hand-rolled ~60-line Prometheus-text
  counter/gauge registry rather than `prom-client` or an import of Lab 38's
  own (sibling, independently-built) metrics approach - both a
  independent-labs-principle requirement and a deliberate CLAUDE.md
  "Dependencies" choice, since this capstone wants what a counter/gauge
  actually is to stay visible, not hidden behind a library. Ports
  5440/8440/6440 (Postgres/PGweb/Redis), metrics server on 9440.
