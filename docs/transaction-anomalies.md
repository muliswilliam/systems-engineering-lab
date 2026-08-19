# Transaction Anomalies

This document is built out starting with `labs/06-mvcc-and-visibility` through
`labs/09-serializable-and-retries`, where each anomaly is reproduced against a
real running PostgreSQL instance rather than described abstractly.

Planned coverage:

- dirty read (not possible in PostgreSQL at any isolation level)
- non-repeatable read (`labs/07-isolation-read-committed`)
- phantom read
- lost update (`labs/11-conditional-writes-and-optimistic-concurrency`)
- write skew (`labs/08-repeatable-read-and-snapshots`, `labs/09-serializable-and-retries`)
- serialization failure and retry (`labs/09-serializable-and-retries`)

Each entry will include: the isolation levels under which it can occur in
PostgreSQL, a minimal two-transaction reproduction, and the fix.
