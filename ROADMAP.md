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

- [ ] 05 - transactions-and-atomicity
- [ ] 06 - mvcc-and-visibility
- [x] 07 - isolation-read-committed - two independent `pg.Client` connections drive raw `BEGIN`/`SET TRANSACTION ISOLATION LEVEL`/`COMMIT` to reproduce a non-repeatable read under the default Read Committed level (same still-open transaction, two SELECTs of the same row, a committed UPDATE in between returns a different value each time) and to prove Postgres never exposes a dirty read even when a transaction explicitly requests `READ UNCOMMITTED` - plus a direct A/B comparison showing `READ UNCOMMITTED` and `READ COMMITTED` produce byte-for-byte identical read behavior even though `SHOW transaction_isolation` echoes back whichever label was requested. Domain: banking/ledger (a single `accounts` table). Ports 5407/8407.
- [ ] 08 - repeatable-read-and-snapshots
- [ ] 09 - serializable-and-retries

## Phase 3 - Locks and Concurrency Control

- [ ] 10 - row-locks-and-select-for-update
- [ ] 11 - conditional-writes-and-optimistic-concurrency
- [ ] 12 - ticket-reservation-system
- [ ] 13 - advisory-locks

## Phase 4 - Background Work and Messaging

- [ ] 14 - job-queue-skip-locked
- [ ] 15 - idempotency-and-deduplication
- [ ] 16 - transactional-outbox
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
  07 banking/ledger (a minimal single-table `accounts` slice - no
  `transfers`/`ledger_entries` table yet, since Lab 07 is about isolation
  semantics, not a rich relational model; a fuller ledger domain is expected
  to land with Lab 09's Serializable lab, which needs a real multi-row
  invariant).
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
