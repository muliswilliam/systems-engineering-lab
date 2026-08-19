-- Run on the primary: per-replica WAL lag in bytes and estimated time.
SELECT
  application_name,
  client_addr,
  state,
  pg_wal_lsn_diff(pg_current_wal_lsn(), sent_lsn) AS sent_lag_bytes,
  pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS replay_lag_bytes,
  replay_lag AS replay_lag_interval
FROM pg_stat_replication;
