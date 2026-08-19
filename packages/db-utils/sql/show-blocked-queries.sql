-- Which backend is blocking which, and on what query.
SELECT
  blocked.pid AS blocked_pid,
  blocked_activity.usename AS blocked_user,
  left(blocked_activity.query, 120) AS blocked_query,
  blocking.pid AS blocking_pid,
  blocking_activity.usename AS blocking_user,
  left(blocking_activity.query, 120) AS blocking_query
FROM pg_locks blocked
JOIN pg_stat_activity blocked_activity ON blocked_activity.pid = blocked.pid
JOIN pg_locks blocking
  ON blocking.locktype = blocked.locktype
  AND blocking.database IS NOT DISTINCT FROM blocked.database
  AND blocking.relation IS NOT DISTINCT FROM blocked.relation
  AND blocking.page IS NOT DISTINCT FROM blocked.page
  AND blocking.tuple IS NOT DISTINCT FROM blocked.tuple
  AND blocking.transactionid IS NOT DISTINCT FROM blocked.transactionid
  AND blocking.pid <> blocked.pid
  AND blocking.granted
JOIN pg_stat_activity blocking_activity ON blocking_activity.pid = blocking.pid
WHERE NOT blocked.granted;
