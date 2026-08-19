import type { Pool, QueryResultRow } from "pg";

/**
 * Runs `fn` inside a transaction with the given planner GUCs set via `SET
 * LOCAL` (so they only affect this one transaction/client, then vanish on
 * rollback - no risk of leaking planner settings to other tests or other
 * pool connections). This is the technique this lab's tests use to assert
 * index-related structural facts deterministically, regardless of table
 * size: on a small test dataset, Postgres's default cost-based planner
 * correctly prefers a sequential scan even when an index exists (fewer
 * pages = cheaper), so asserting "the default plan uses Index Scan" would
 * be flaky/false against a small dataset. Forcing the planner's hand with
 * `enable_seqscan`/`enable_indexscan`/etc. instead answers the question
 * these tests actually care about: is this index valid and usable, and
 * does the row set it returns match a sequential scan exactly?
 */
export async function withPlannerSettings<T>(
  pool: Pool,
  settings: string[],
  fn: (client: { query: Pool["query"] }) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const setting of settings) {
      await client.query(setting);
    }
    const result = await fn(client);
    await client.query("ROLLBACK");
    return result;
  } finally {
    client.release();
  }
}

export const FORCE_INDEX_SETTINGS = ["SET LOCAL enable_seqscan = off"];
export const FORCE_SEQ_SCAN_SETTINGS = [
  "SET LOCAL enable_indexscan = off",
  "SET LOCAL enable_indexonlyscan = off",
  "SET LOCAL enable_bitmapscan = off",
];

export async function explainWithSettings(
  pool: Pool,
  settings: string[],
  queryText: string,
  params: unknown[] = [],
): Promise<string> {
  return withPlannerSettings(pool, settings, async (client) => {
    const result = await client.query(`EXPLAIN ${queryText}`, params);
    return result.rows.map((row: { "QUERY PLAN": string }) => row["QUERY PLAN"]).join("\n");
  });
}

export async function queryWithSettings<T extends QueryResultRow>(
  pool: Pool,
  settings: string[],
  queryText: string,
  params: unknown[] = [],
): Promise<T[]> {
  return withPlannerSettings(pool, settings, async (client) => {
    const result = await client.query<T>(queryText, params);
    return result.rows;
  });
}

/** Order-independent deep comparison helper - sorts rows by their JSON form. */
export function sortRows<T>(rows: T[]): T[] {
  return [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
