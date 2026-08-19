import type { Pool } from "pg";

export interface TableStats {
  relationSizeBytes: number;
  totalRelationSizeBytes: number;
  liveTuples: number;
  deadTuples: number;
  lastVacuum: string | null;
  lastAutovacuum: string | null;
  vacuumCount: number;
  autovacuumCount: number;
}

/**
 * Reads real, live PostgreSQL-native observability data for one table -
 * exactly the kind of query CLAUDE.md's "PostgreSQL Inspection" section asks
 * every lab to expose, rather than a synthetic in-app counter:
 *
 * - `pg_relation_size(oid)`: the size of the table's main heap fork ONLY, in
 *   bytes - this is what grows when dead tuples accumulate and pages have to
 *   be extended to fit new tuple versions, and what plain `VACUUM` does NOT
 *   shrink (it only marks space reusable), but `VACUUM FULL` does.
 * - `pg_total_relation_size(oid)`: the heap PLUS all indexes, the TOAST
 *   table, and the TOAST index - the number that matters for "how much disk
 *   does this table actually cost me," since bloated indexes are a real,
 *   separate cost bloat imposes beyond the heap itself.
 * - `pg_stat_user_tables.n_live_tup`/`n_dead_tup`: maintained by Postgres's
 *   statistics collector on every INSERT/UPDATE/DELETE, independent of
 *   whether autovacuum is enabled or has ever run - these are real counts,
 *   not estimates that require a fresh `ANALYZE` to be meaningful (though
 *   `ANALYZE` does refine them).
 * - `last_vacuum`/`last_autovacuum`/`vacuum_count`/`autovacuum_count`: proof
 *   that a vacuum (manual or automatic) genuinely ran, not just that dead
 *   tuples happen to be lower than before.
 */
export async function getTableStats(pool: Pool, tableName: string): Promise<TableStats> {
  const result = await pool.query<{
    relation_size: string;
    total_relation_size: string;
    n_live_tup: string;
    n_dead_tup: string;
    last_vacuum: string | null;
    last_autovacuum: string | null;
    vacuum_count: string;
    autovacuum_count: string;
  }>(
    `SELECT
       pg_relation_size($1::regclass) AS relation_size,
       pg_total_relation_size($1::regclass) AS total_relation_size,
       coalesce(s.n_live_tup, 0) AS n_live_tup,
       coalesce(s.n_dead_tup, 0) AS n_dead_tup,
       s.last_vacuum,
       s.last_autovacuum,
       coalesce(s.vacuum_count, 0) AS vacuum_count,
       coalesce(s.autovacuum_count, 0) AS autovacuum_count
     FROM pg_stat_user_tables s
     WHERE s.relname = $2
     UNION ALL
     SELECT pg_relation_size($1::regclass), pg_total_relation_size($1::regclass), 0, 0, NULL, NULL, 0, 0
     WHERE NOT EXISTS (SELECT 1 FROM pg_stat_user_tables WHERE relname = $2)
     LIMIT 1`,
    [tableName, tableName],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`no stats row returned for table "${tableName}"`);
  }

  return {
    relationSizeBytes: Number(row.relation_size),
    totalRelationSizeBytes: Number(row.total_relation_size),
    liveTuples: Number(row.n_live_tup),
    deadTuples: Number(row.n_dead_tup),
    lastVacuum: row.last_vacuum,
    lastAutovacuum: row.last_autovacuum,
    vacuumCount: Number(row.vacuum_count),
    autovacuumCount: Number(row.autovacuum_count),
  };
}

export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)}MB`;
}

export interface ExplainResult {
  executionTimeMs: number;
  planningTimeMs: number;
  sharedHitBlocks: number;
  sharedReadBlocks: number;
  actualRows: number;
}

interface JsonPlanNode {
  "Actual Rows"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
}
interface JsonPlanRoot {
  Plan: JsonPlanNode;
  "Execution Time": number;
  "Planning Time": number;
}

/**
 * Runs a real sequential scan (`SELECT count(*)`, which cannot use an index -
 * every row must be visited) via `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`
 * and extracts the numbers that make bloat's cost concrete: not just "it
 * took longer" but "it touched measurably more 8KB pages" - the direct,
 * physical reason it took longer. `BUFFERS` reports `Shared Hit/Read Blocks`
 * regardless of whether those pages came from Postgres's own buffer cache
 * (hit) or the OS/disk (read), so this is a fair page-count comparison even
 * when both tables happen to be fully cached.
 */
export async function explainSeqScanCount(pool: Pool, tableName: string): Promise<ExplainResult> {
  const result = await pool.query<{ "QUERY PLAN": JsonPlanRoot[] }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT count(*) FROM ${tableName}`,
  );
  const plan = result.rows[0]?.["QUERY PLAN"][0];
  if (!plan) {
    throw new Error(`no plan returned for ${tableName}`);
  }
  return {
    executionTimeMs: plan["Execution Time"],
    planningTimeMs: plan["Planning Time"],
    sharedHitBlocks: plan.Plan["Shared Hit Blocks"] ?? 0,
    sharedReadBlocks: plan.Plan["Shared Read Blocks"] ?? 0,
    actualRows: plan.Plan["Actual Rows"] ?? 0,
  };
}
