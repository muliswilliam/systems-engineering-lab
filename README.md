# Backend Systems Engineering Lab

A hands-on backend systems laboratory for practicing PostgreSQL concurrency,
distributed messaging, caching, replication, reliability, and production
engineering patterns using TypeScript and Drizzle.

This is not a beginner CRUD tutorial. It is an engineering practice
environment built to make invisible production behavior - race conditions,
lock waits, replication lag, retries, serialization failures - visible,
reproducible, and understandable.

See [`SPEC.md`](./SPEC.md) for the full curriculum design and
[`ROADMAP.md`](./ROADMAP.md) for current lab status. Track your own
progress through the curriculum in [`PROGRESS.md`](./PROGRESS.md).

## How this repository works

Every lab under `labs/` is fully independent: its own Docker Compose stack,
its own database, its own migrations, its own seed data, its own tests. You
can run any lab in isolation without any other lab running.

Each lab follows the same learning loop:

1. **Predict** what should happen.
2. **Run** the experiment.
3. **Observe** what actually happens (via PGweb, `psql`, structured logs, or
   `pg_locks`/`pg_stat_activity`).
4. **Explain** why.
5. **Break it** - reproduce the failure mode on purpose.
6. **Fix it** - implement the production-safe version.
7. **Compare tradeoffs**.

## Prerequisites

- Node.js >= 20
- pnpm
- Docker + Docker Compose

## Getting started

```bash
pnpm install
pnpm lab:list
pnpm lab:start 01
```

Then open the lab's own `README.md` under `labs/01-postgres-drizzle-foundation/`
for setup, scenario, and exercises.

## Root commands

```bash
pnpm lab:list          # list all labs
pnpm lab:start <n>     # docker compose up -d for lab n
pnpm lab:stop <n>      # docker compose down for lab n
pnpm lab:reset <n>     # docker compose down -v for lab n (clean slate)
pnpm lab:test <n>      # pnpm test inside lab n
```

## Repository layout

```text
docs/          shared reference material (glossary, cheatsheets, ADRs)
packages/      shared, genuinely reusable code (data generators, db-utils, logging, test-utils)
labs/          independent, numbered labs - the curriculum itself
```

## Shared packages

- `@labs/data-generators` - deterministic, seeded, realistic domain data (payroll, ticketing, commerce, ledger, jobs)
- `@labs/db-utils` - a small pg Pool helper plus reusable PostgreSQL inspection SQL scripts
- `@labs/logging` - a Pino logger factory with consistent structured fields
- `@labs/test-utils` - concurrency test helpers (run N operations concurrently, assert invariants)

No lab depends on another lab's running services, database, or generated
artifacts - only on these shared packages.
