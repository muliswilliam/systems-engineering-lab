# CLAUDE.md

## Purpose

This repository is a hands-on backend systems laboratory for practicing production-oriented backend engineering concepts using TypeScript, Drizzle ORM, PostgreSQL, Docker Compose, PGweb, and supporting infrastructure where needed.

Claude Code must treat this repository as a structured curriculum, not as a collection of unrelated demos.

Before making any meaningful change:

1. Read `SPEC.md`.
2. Read `ROADMAP.md` if it exists.
3. Read the target lab's `README.md`.
4. Preserve the repository conventions described below.

The primary goal is to make backend behavior observable, reproducible, and understandable through deliberate practice.

---

## Core Principles

### 1. Preserve independent labs

Every lab must run independently.

A lab must not depend on another lab's:

- Docker network;
- database;
- migrations;
- seed state;
- running process;
- generated artifacts.

Shared packages may be used for utilities, generators, logging, or test helpers.

Each lab should own its own:

- `docker-compose.yml`;
- `.env.example`;
- `package.json`;
- Drizzle config;
- schema;
- migrations;
- seed script;
- scenarios;
- tests;
- README.

---

### 2. Show failure before the fix

Where the concept allows it, structure labs as:

1. naive implementation;
2. reproduce the bug or race condition;
3. observe the failure;
4. implement the corrected approach;
5. verify the invariant;
6. document tradeoffs.

Do not skip directly to the safe implementation if doing so hides the reason the concept matters.

---

### 3. Prefer datastore-native guarantees

When protecting data invariants:

- prefer PostgreSQL constraints;
- transactions;
- conditional writes;
- row locks;
- isolation levels;
- unique constraints;

before introducing external coordination.

Do not reach for Redis or distributed locks when PostgreSQL can safely enforce the invariant more directly.

Use advisory locks and distributed locks only where they are actually the concept being taught or where cross-process coordination is genuinely needed.

---

### 4. ORM plus SQL

Drizzle is the default ORM.

However, do not hide PostgreSQL-specific behavior behind abstractions.

Use raw SQL where it is clearer or necessary, especially for:

- `SELECT ... FOR UPDATE`;
- `SKIP LOCKED`;
- advisory locks;
- `pg_locks`;
- `pg_stat_activity`;
- isolation-level experiments;
- query plans;
- replication inspection;
- PostgreSQL system catalogs;
- `CREATE INDEX CONCURRENTLY`;
- lock diagnostics.

Where practical, show the equivalent SQL alongside Drizzle code.

---

## Technology Defaults

Use these unless a lab requires something different:

- Node.js
- TypeScript
- pnpm
- Drizzle ORM
- `pg`
- PostgreSQL
- Docker
- Docker Compose
- PGweb
- Vitest
- Pino
- Zod where runtime validation is useful

Only introduce additional infrastructure when the lab actually needs it.

Examples:

- Redis for caching/distributed-lock labs;
- PgBouncer for pooling labs;
- a message broker for messaging labs;
- Prometheus/Grafana only where observability is a learning objective.

Avoid dependency sprawl.

---

## Repository Structure

Expected high-level shape:

```text
backend-systems-labs/
├── README.md
├── SPEC.md
├── ROADMAP.md
├── CLAUDE.md
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── docs/
├── packages/
└── labs/
```

Typical lab:

```text
labs/XX-lab-name/
├── README.md
├── docker-compose.yml
├── .env.example
├── package.json
├── drizzle.config.ts
├── src/
│   ├── db/
│   ├── seed/
│   ├── scenarios/
│   ├── scripts/
│   └── index.ts
├── drizzle/
├── tests/
└── playground/
```

Where useful:

```text
├── naive/
├── solution/
└── diagrams/
```

---

## Lab README Requirements

Every lab README should contain the following sections unless clearly irrelevant:

1. Title
2. Why this exists
3. Learning objectives
4. Architecture
5. Setup
6. Scenario
7. Prediction
8. Exercise
9. Observe
10. Break it
11. Fix it
12. Why the fix works
13. Tradeoffs
14. Production notes
15. Interview questions
16. Further experiments

The README must be runnable, not aspirational.

Commands must match the actual repository.

---

## Docker Compose Rules

For PostgreSQL-based labs:

- include PostgreSQL;
- include PGweb by default;
- add health checks;
- use predictable service names;
- make local ports explicit;
- avoid hidden dependencies on external services;
- support clean reset with:

```bash
docker compose down -v
```

A clean reset should return the lab to a known state.

For multi-node PostgreSQL labs, expose separate service names and, where useful, separate PGweb instances.

---

## PGweb

PGweb is the default lightweight browser-based PostgreSQL viewer.

PostgreSQL labs should make it easy to inspect:

- tables;
- rows;
- schemas;
- indexes;
- transaction-visible state where possible.

Do not substitute pgAdmin unless explicitly requested.

---

## Data Generation

Seed data must be realistic and deterministic.

Use a seeded generator such as `@faker-js/faker`.

Do not generate meaningless random records.

Prefer coherent domains:

- payroll;
- ticketing;
- commerce;
- banking/ledger;
- background jobs.

Relationships must make sense.

Examples:

- employees belong to real companies;
- salaries fit role bands;
- ticket seats belong to a venue section;
- orders reference actual products;
- payroll periods precede payroll results;
- manager relationships are valid.

Large data labs should generate data locally rather than commit huge fixtures.

Support commands such as:

```bash
pnpm seed --seed=42
pnpm seed --size=small
pnpm seed --size=medium
pnpm seed --size=large
pnpm seed --rows=1000000
```

Large generators should batch or stream inserts instead of loading millions of records into memory.

---

## IDs

Where useful, model both:

- an internal numeric ID;
- a public UUID.

Example:

```text
id           bigint
public_id    uuid
```

Use numeric IDs internally for joins, advisory-lock keys, and internal references when appropriate.

Expose UUIDs externally where the lab models an API-facing entity.

---

## Migrations

Use Drizzle migrations by default.

Do not hand-edit generated migrations unless there is a clear reason and the lab explains it.

Migration labs must demonstrate real operational concerns:

- blocking DDL;
- compatibility with old app versions;
- expand/contract;
- concurrent indexes;
- backfills;
- replica lag;
- long-running transactions.

Never present unsafe schema changes as universally safe.

---

## Transactions and Concurrency

Concurrency labs must be written so behavior is reproducible.

Prefer multiple explicit workers/processes over fake sequential examples.

Include:

- timestamps;
- worker IDs;
- transaction IDs where useful;
- delays only when needed to make the race observable.

Do not assert correctness based purely on execution order or sleeps.

Tests should assert invariants.

Example:

```text
100 concurrent seat reservation attempts
→ exactly 1 successful reservation
```

Better than:

```text
worker A finishes before worker B
```

---

## Logging

Use Pino for structured logs.

Concurrent work should include relevant fields such as:

```json
{
  "workerId": "worker-3",
  "jobId": 102,
  "eventId": "evt_...",
  "transactionId": "tx_...",
  "attempt": 2
}
```

Avoid relying entirely on bare `console.log`.

Logs should make timing and concurrency visible.

---

## Testing

Use Vitest.

Labs should include the kinds of tests appropriate to the concept:

- unit tests;
- integration tests;
- concurrency tests;
- invariant tests;
- failure-path tests.

When timing is involved, avoid fragile assertions where possible.

Prefer final-state assertions and database invariants.

---

## Failure Injection

Later labs should deliberately inject failures where relevant.

Examples:

- worker crash;
- duplicate message delivery;
- timeout;
- broker failure;
- Redis outage;
- replica lag;
- process pause;
- connection exhaustion;
- failed downstream request.

Failure injection should be configurable or deterministic where possible.

Do not add chaos for its own sake. It must support a learning objective.

---

## PostgreSQL Inspection

Use PostgreSQL's own observability tools.

Useful views and functions include:

```sql
pg_stat_activity
pg_locks
pg_stat_user_tables
pg_stat_user_indexes
```

Provide reusable SQL scripts where useful for:

- active transactions;
- blocked queries;
- lock holders;
- long-running transactions;
- replication lag;
- table stats;
- index usage.

Store broadly reusable versions under a shared package such as:

```text
packages/db-utils/sql/
```

---

## Job Queues

For PostgreSQL job queue labs, prefer:

```sql
SELECT ...
FROM jobs
WHERE status = 'pending'
ORDER BY created_at
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

Demonstrate behavior with multiple workers.

Where appropriate, include:

- retries;
- attempts;
- terminal failure;
- processing leases/timeouts;
- crash recovery.

---

## Transactional Outbox

Outbox labs must clearly demonstrate the dual-write problem before showing the pattern.

Expected flow:

```text
BEGIN
write business state
write outbox event
COMMIT
```

Publisher workers should use `SKIP LOCKED` where appropriate.

Do not imply that the outbox magically prevents duplicate publication.

Consumers must be taught to be idempotent.

---

## Idempotency

Whenever retries can repeat side effects, include idempotency.

Useful techniques:

- idempotency key;
- unique constraint;
- processed-message table;
- deterministic command ID;
- stored result.

Make the duplicate behavior observable before fixing it.

---

## Advisory Locks

Teach advisory locks as application coordination.

Do not describe them as automatic row protection.

When using them:

- choose deliberate lock granularity;
- prefer transaction-level locks when appropriate;
- demonstrate blocking and try-lock variants;
- explain connection/session implications.

Where IDs are UUIDs, either:

- use a stable numeric internal ID;
- or explicitly hash the UUID into a lock key and document collision tradeoffs.

---

## Distributed Locks

Distributed locks should be treated as an advanced coordination mechanism.

When demonstrating Redis locks/leasing, include:

- ownership token;
- expiration;
- safe release;
- process pause;
- lease expiry while work continues;
- fencing-token concept.

Always compare against simpler alternatives:

- database transaction;
- conditional write;
- unique constraint;
- advisory lock.

---

## Replication

Replication labs should distinguish:

- primary;
- standby/read replica;
- WAL generation;
- WAL replay;
- lag;
- read routing;
- failover.

Read/write routing should explicitly show:

```text
writes → primary
ordinary reads → replica
read-after-write-sensitive reads → primary
transactions → primary
```

Replica labs should make stale reads observable.

Do not imply replication is synchronous unless configured as such.

---

## Cascading Replicas

When modeling cascading replicas:

- show the replication topology clearly;
- explain primary fan-out reduction;
- expose additional propagation lag;
- demonstrate the operational consequence of an upstream replica failing.

---

## PgBouncer

PgBouncer labs should compare:

- direct application connections;
- pooled connections.

Cover at least:

- session pooling;
- transaction pooling;
- connection pressure;
- session-state caveats where relevant.

Do not claim PgBouncer performs read/write routing.

It pools connections; routing must be implemented elsewhere.

---

## Isolation Levels

Labs should cover:

- Read Committed;
- Repeatable Read;
- Serializable.

Note PostgreSQL behavior:

- dirty reads do not occur;
- `READ UNCOMMITTED` behaves like Read Committed.

Serializable labs must include retry logic.

Do not present Serializable as "free safety."

Explain contention, aborts, and retry requirements.

---

## Safe Migrations

Schema-evolution labs should favor expand/contract.

Example:

```text
add new column
→ deploy compatible code
→ dual write
→ backfill
→ switch reads
→ stop old writes
→ remove old column later
```

Use `CREATE INDEX CONCURRENTLY` where appropriate.

Large backfills must be batched and resumable.

---

## Query Performance

Performance labs must measure before changing anything.

Required workflow:

```text
measure
→ inspect query plan
→ form hypothesis
→ modify
→ measure again
```

Use:

```sql
EXPLAIN
EXPLAIN ANALYZE
```

Do not add indexes blindly.

Explain write amplification and maintenance cost.

---

## Security

Database security labs should cover:

- least privilege;
- application DB user;
- migration DB user;
- read-only role;
- row-level security;
- tenant isolation.

Never commit credentials.

Use `.env.example`, not real secrets.

---

## Commands

Prefer consistent root commands.

Examples:

```bash
pnpm lab:list
pnpm lab:start 14
pnpm lab:stop 14
pnpm lab:reset 14
pnpm lab:test 14
```

Inside a lab, prefer:

```bash
pnpm dev
pnpm seed
pnpm test
pnpm db:generate
pnpm db:migrate
pnpm db:reset
```

Where useful:

```bash
pnpm scenario:naive
pnpm scenario:fixed
```

Do not invent commands in documentation without implementing them.

---

## Coding Style

Prefer:

- small focused modules;
- explicit names;
- readable SQL;
- clear transaction boundaries;
- minimal abstraction in educational code;
- typed domain state;
- exhaustive state handling where useful.

Avoid:

- premature frameworks;
- giant service classes;
- hidden global state;
- unnecessary dependency injection;
- abstractions that make concurrency invisible.

Educational clarity is more important than architectural fashion.

---

## TypeScript

Use strict TypeScript.

Prefer:

- `unknown` over `any`;
- explicit result types in core concurrency code;
- discriminated unions for state machines;
- narrow error types where practical.

Do not over-engineer types in simple seed or lab scaffolding.

---

## Dependencies

Before adding a dependency:

1. check whether the standard library or existing dependency already solves it;
2. confirm it serves the lab's learning objective;
3. avoid pulling in large frameworks for tiny helpers.

Keep infrastructure minimal.

---

## Documentation Quality

Documentation should explain:

- what guarantee a technique provides;
- what it does not guarantee;
- what happens on crash;
- what happens under retry;
- what happens with stale reads;
- what happens under high contention;
- what changes across regions;
- what simpler alternative exists.

Do not write vague "production ready" claims.

Be precise.

---

## Interview Questions

Every lab should include a short interview section.

Questions should test reasoning, not trivia.

Examples:

- Why would `SKIP LOCKED` be better than an advisory lock here?
- When would optimistic concurrency beat a row lock?
- Why can an outbox event be published twice?
- How would replication lag affect this API?
- What invariant belongs in PostgreSQL rather than Redis?
- Why might Serializable reduce throughput?

---

## Production Notes

Every lab should end with production notes that answer:

1. What guarantee does this mechanism give?
2. What guarantee does it not give?
3. What failure mode remains?
4. How does contention affect it?
5. What changes at larger scale?
6. What metrics would be monitored?
7. When should this approach be avoided?

---

## Definition of Done

A lab is complete only if:

- Docker Compose starts successfully;
- required services become healthy;
- PGweb connects where applicable;
- migrations apply;
- seed script succeeds;
- README commands work;
- naive scenario reproduces the intended issue;
- corrected scenario demonstrates the intended guarantee;
- tests pass;
- failure scenario is reproducible;
- production notes exist;
- interview questions exist;
- reset instructions work;
- the lab has no hidden dependency on another lab.

---

## When Adding a New Lab

Before coding:

1. identify the concept;
2. identify the invariant or production problem;
3. decide whether the failure can be reproduced locally;
4. choose the smallest useful domain;
5. define the naive scenario;
6. define the corrected scenario;
7. define what the learner should observe;
8. define how correctness will be tested.

Then implement in this order:

1. Docker services;
2. schema;
3. migration;
4. deterministic seed data;
5. naive scenario;
6. corrected scenario;
7. tests;
8. README;
9. cleanup/reset flow.

---

## When Modifying an Existing Lab

Do not silently change the learning objective.

Preserve:

- lab independence;
- documented commands;
- reproducibility;
- data determinism;
- failure scenario;
- invariant tests.

If the change materially alters the concept, update the README and, if needed, `SPEC.md` or `ROADMAP.md`.

---

## Claude Code Behavior

When working in this repository:

- do not ask unnecessary clarification questions when the spec already answers them;
- make a reasonable implementation decision and document it;
- prefer complete working changes over partial scaffolding;
- run tests before declaring work complete;
- run formatting/linting if configured;
- verify Docker Compose syntax when changed;
- verify README commands when feasible;
- summarize what changed and any remaining caveats.

Do not replace educational code with overly abstract framework code.

Do not hide the database behavior the lab exists to teach.

---

## Final Guiding Questions

For every implementation, keep asking:

> What invariant are we protecting?

> Where should that invariant live?

> What happens if the process crashes here?

> What happens if the request runs twice?

> What happens if the read is stale?

> What happens with 1,000 concurrent workers?

> What is the simplest mechanism that provides the guarantee we actually need?

Those questions define the engineering style of this repository.
