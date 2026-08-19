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
- [ ] 04 - indexes-and-performance-basics

## Phase 2 - Transactions and PostgreSQL Concurrency

- [ ] 05 - transactions-and-atomicity
- [ ] 06 - mvcc-and-visibility
- [ ] 07 - isolation-read-committed
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
- Domains by lab, so far: 01 payroll, 02 payroll, 03 commerce.
