# Lock Reference

Built out starting with `labs/10-row-locks-and-select-for-update` through
`labs/13-advisory-locks` and `labs/32-deadlocks-and-lock-debugging`.

Planned coverage:

- row-level lock modes: `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE`, `FOR KEY SHARE`
- `NOWAIT` and `lock_timeout`
- table-level lock modes relevant to migrations (`ACCESS EXCLUSIVE`, etc.)
- advisory locks: session-level vs transaction-level, `pg_try_advisory_lock`
  vs `pg_advisory_lock`, hashing a UUID into a bigint lock key
- how to read `pg_locks` and `pg_stat_activity` together to find a blocker
- deadlock detection and deterministic lock ordering as the fix
