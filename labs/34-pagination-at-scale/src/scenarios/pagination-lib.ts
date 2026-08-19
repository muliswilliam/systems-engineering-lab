import type { Pool } from "pg";

export interface ActivityEventRow {
  id: number;
  public_id: string;
  actor_name: string;
  action: string;
  target_type: string;
  target_id: string;
  created_at: string;
}

export interface Cursor {
  createdAt: string;
  id: number;
}

const COLUMNS = "id, public_id, actor_name, action, target_type, target_id, created_at";

/**
 * The naive OFFSET query this entire lab exists to critique. Every row
 * before OFFSET must still be produced by the underlying scan and then
 * thrown away by the Limit node - the index on `(created_at, id)` lets
 * Postgres avoid a full sort, but it cannot skip the "walk past N rows"
 * cost, because an index only tells Postgres the ORDER of rows, not how to
 * jump directly to the Nth one.
 */
function offsetSql(): string {
  return `SELECT ${COLUMNS} FROM activity_events ORDER BY created_at, id LIMIT $1 OFFSET $2`;
}

/**
 * The keyset/cursor query. `WHERE (created_at, id) > (cursor)` is a row-wise
 * comparison (PostgreSQL evaluates it lexicographically, exactly like
 * comparing two-column tuples) - it lets the planner seek directly to the
 * first index entry greater than the cursor and read exactly `limit` rows
 * forward, regardless of how deep that cursor is in the overall table.
 */
function keysetSql(): string {
  return `
    SELECT ${COLUMNS} FROM activity_events
    WHERE (created_at, id) > ($1, $2)
    ORDER BY created_at, id
    LIMIT $3
  `;
}

function firstPageKeysetSql(): string {
  return `SELECT ${COLUMNS} FROM activity_events ORDER BY created_at, id LIMIT $1`;
}

/** Real data fetch (not EXPLAIN) - used by correctness scenarios/tests that need actual rows. */
export async function runOffsetPage(pool: Pool, offset: number, limit: number): Promise<ActivityEventRow[]> {
  const { rows } = await pool.query<ActivityEventRow>(offsetSql(), [limit, offset]);
  return rows;
}

/** Real data fetch (not EXPLAIN) - used by correctness scenarios/tests that need actual rows. */
export async function runKeysetPage(pool: Pool, cursor: Cursor | null, limit: number): Promise<ActivityEventRow[]> {
  if (!cursor) {
    const { rows } = await pool.query<ActivityEventRow>(firstPageKeysetSql(), [limit]);
    return rows;
  }
  const { rows } = await pool.query<ActivityEventRow>(keysetSql(), [cursor.createdAt, cursor.id, limit]);
  return rows;
}

export function cursorFromRow(row: ActivityEventRow): Cursor {
  return { createdAt: row.created_at, id: row.id };
}

/**
 * Reads the (created_at, id) tuple that sits at a given zero-based OFFSET,
 * purely to SYNTHESIZE a valid keyset cursor for benchmarking at "equivalent
 * depth" to an OFFSET scenario. This is a deliberate benchmarking shortcut,
 * NOT how a real client obtains a cursor - a real client only ever has the
 * cursor from the LAST ROW OF THE PREVIOUS PAGE IT ALREADY FETCHED. See
 * README "Tradeoffs": this is exactly why arbitrary page-N jumps are not
 * possible with keyset pagination the way they are with OFFSET.
 */
export async function getCursorAtOffset(pool: Pool, offset: number): Promise<Cursor> {
  const { rows } = await pool.query<{ created_at: string; id: number }>(
    "SELECT created_at, id FROM activity_events ORDER BY created_at, id OFFSET $1 LIMIT 1",
    [offset],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`No row at offset ${offset} - is the table seeded with enough rows?`);
  }
  return { createdAt: row.created_at, id: row.id };
}

export interface PlanBuffers {
  sharedHit: number;
  sharedRead: number;
}

export interface ExplainResult {
  planningTimeMs: number;
  executionTimeMs: number;
  topNodeType: string;
  buffers: PlanBuffers;
  raw: unknown;
}

interface RawPlanNode {
  "Node Type": string;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: RawPlanNode[];
  [key: string]: unknown;
}

function sumBuffers(node: RawPlanNode): PlanBuffers {
  let sharedHit = node["Shared Hit Blocks"] ?? 0;
  let sharedRead = node["Shared Read Blocks"] ?? 0;
  for (const child of node.Plans ?? []) {
    const childSum = sumBuffers(child);
    sharedHit += childSum.sharedHit;
    sharedRead += childSum.sharedRead;
  }
  return { sharedHit, sharedRead };
}

async function explain(pool: Pool, sqlText: string, params: unknown[]): Promise<ExplainResult> {
  const { rows } = await pool.query<{ "QUERY PLAN": [{ Plan: RawPlanNode; "Planning Time": number; "Execution Time": number }] }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sqlText}`,
    params,
  );
  const plan = rows[0]!["QUERY PLAN"][0];
  return {
    planningTimeMs: plan["Planning Time"],
    executionTimeMs: plan["Execution Time"],
    topNodeType: plan.Plan["Node Type"],
    buffers: sumBuffers(plan.Plan),
    raw: plan,
  };
}

/** EXPLAIN ANALYZE over the real OFFSET query - real, Postgres-reported execution time. */
export async function explainOffsetPage(pool: Pool, offset: number, limit: number): Promise<ExplainResult> {
  return explain(pool, offsetSql(), [limit, offset]);
}

/** EXPLAIN ANALYZE over the real keyset query - real, Postgres-reported execution time. */
export async function explainKeysetPage(pool: Pool, cursor: Cursor | null, limit: number): Promise<ExplainResult> {
  if (!cursor) {
    return explain(pool, firstPageKeysetSql(), [limit]);
  }
  return explain(pool, keysetSql(), [cursor.createdAt, cursor.id, limit]);
}

export async function getTotalRowCount(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ count: string }>("SELECT count(*) FROM activity_events");
  return Number(rows[0]!.count);
}

/** Runs `fn` `iterations` times and returns the median of the returned numbers - reduces noise from a single slow/fast outlier run without hiding a real trend across depths. */
export async function median(iterations: number, fn: () => Promise<number>): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    samples.push(await fn());
  }
  samples.sort((a, b) => a - b);
  const mid = Math.floor(samples.length / 2);
  return samples.length % 2 === 0 ? ((samples[mid - 1]! + samples[mid]!) / 2) : samples[mid]!;
}
