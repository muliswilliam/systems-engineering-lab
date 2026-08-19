-- Active (non-idle) backends and how long their current transaction has been open.
SELECT
  pid,
  usename,
  application_name,
  state,
  wait_event_type,
  wait_event,
  now() - xact_start AS transaction_age,
  now() - query_start AS query_age,
  left(query, 120) AS query
FROM pg_stat_activity
WHERE state <> 'idle'
  AND pid <> pg_backend_pid()
ORDER BY transaction_age DESC NULLS LAST;
