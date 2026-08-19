# Glossary

Terms are added as the labs that teach them land. See the linked lab for a
full treatment; this file gives a one-paragraph working definition.

## MVCC (Multi-Version Concurrency Control)

PostgreSQL's mechanism for letting readers and writers avoid blocking each
other by keeping multiple versions of a row and giving each transaction a
consistent snapshot to read from. See `labs/06-mvcc-and-visibility`.

## WAL (Write-Ahead Log)

The durability and replication log PostgreSQL writes changes to before they
are applied to data files. Physical streaming replication ships WAL to
standbys. See `labs/24-postgres-wal-and-replication-basics`.

## Public ID vs internal ID

`id bigint` is the internal identifier used for joins and advisory-lock keys.
`public_id uuid` is the identifier exposed outside the system. See
`docs/architecture-principles.md`.

## Idempotency key

A client- or server-generated identifier for a single logical operation,
stored with a unique constraint so a retried request cannot apply the same
side effect twice. See `labs/15-idempotency-and-deduplication`.

## Advisory lock

An application-defined lock keyed by an arbitrary bigint (or pair of ints),
tracked by PostgreSQL but not tied to any row or table. Coordinates
application behavior; does not by itself protect any row. See
`labs/13-advisory-locks`.

## SKIP LOCKED

A `SELECT ... FOR UPDATE SKIP LOCKED` clause that lets concurrent workers each
claim a different row instead of queueing behind each other's row locks. See
`labs/14-job-queue-skip-locked`.

## Transactional outbox

A pattern for atomically committing a business change and the event that
announces it, by writing both inside the same database transaction and
publishing the event asynchronously from that table. See
`labs/16-transactional-outbox`.
