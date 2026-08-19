-- Transactions open longer than 5 seconds - candidates for bloat/lock contention.
SELECT
  pid,
  usename,
  application_name,
  state,
  now() - xact_start AS transaction_age,
  left(query, 120) AS query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
  AND now() - xact_start > interval '5 seconds'
  AND pid <> pg_backend_pid()
ORDER BY transaction_age DESC;
