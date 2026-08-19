-- All locks currently held or awaited, joined with the query that holds them.
SELECT
  l.pid,
  l.locktype,
  l.mode,
  l.granted,
  l.relation::regclass AS relation,
  a.state,
  left(a.query, 120) AS query
FROM pg_locks l
JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.pid <> pg_backend_pid()
ORDER BY l.granted, l.pid;
