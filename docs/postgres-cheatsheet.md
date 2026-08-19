# PostgreSQL Cheatsheet

Quick reference commands used repeatedly across labs. Lab-specific variants
live in each lab's README; this file holds the generic versions.

## Connecting

```bash
psql "$DATABASE_URL"
```

## Inspecting schema

```sql
\dt              -- list tables
\d table_name     -- describe a table
\di               -- list indexes
```

## Enabling query logging (session-level)

```sql
SET log_statement = 'all';
```

Or at the Docker Compose level, pass `-c log_statement=all` as a Postgres
command-line flag (see `labs/01-postgres-drizzle-foundation/docker-compose.yml`).

## Reusable inspection scripts

See `packages/db-utils/sql/`:

- `show-active-transactions.sql`
- `show-locks.sql`
- `show-blocked-queries.sql`
- `show-long-running-transactions.sql`
- `show-table-stats.sql`
- `show-index-usage.sql`
- `show-replication-lag.sql` (run on a primary with replicas attached)

Run any of them with:

```bash
psql "$DATABASE_URL" -f ../../packages/db-utils/sql/show-locks.sql
```

## EXPLAIN

```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT ...;
```

`ANALYZE` actually executes the query - do not use it on statements with side
effects unless wrapped in a transaction you intend to roll back.
