# Replication Reference

Built out starting with `labs/24-postgres-wal-and-replication-basics` through
`labs/28-failover-and-role-changes`.

Planned coverage:

- WAL and LSN basics
- physical streaming replication setup in Docker Compose
- primary/replica read-write routing at the ORM level
- measuring and artificially inducing replication lag
- read-after-write strategies (read-your-writes window, LSN-based wait, tolerate staleness)
- cascading replica topologies and fan-out
- failover/promotion mechanics and why this repository does not hand-roll a
  production HA manager
