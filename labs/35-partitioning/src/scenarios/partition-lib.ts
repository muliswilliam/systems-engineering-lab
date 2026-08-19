import type { Pool } from "pg";

export interface PlanBuffers {
  sharedHit: number;
  sharedRead: number;
}

export interface ExplainResult {
  planningTimeMs: number;
  executionTimeMs: number;
  topNodeType: string;
  buffers: PlanBuffers;
  /** Distinct relation names actually visited by a scan node in the plan. */
  relationsScanned: string[];
  raw: unknown;
}

interface RawPlanNode {
  "Node Type": string;
  "Relation Name"?: string;
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

function collectRelations(node: RawPlanNode, out: Set<string>): void {
  if (node["Relation Name"]) {
    out.add(node["Relation Name"]);
  }
  for (const child of node.Plans ?? []) {
    collectRelations(child, out);
  }
}

/**
 * Runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` over `sqlText` and returns
 * REAL Postgres-reported timing/buffer/plan-shape data - never parsed from
 * text output, never estimated. `relationsScanned` is the single most
 * important field in this lab: for a partitioned table, it is the direct,
 * structural proof of partition pruning (or its absence) - the literal list
 * of child partitions the planner decided it needed to touch.
 */
export async function explain(pool: Pool, sqlText: string, params: unknown[] = []): Promise<ExplainResult> {
  const { rows } = await pool.query<{
    "QUERY PLAN": [{ Plan: RawPlanNode; "Planning Time": number; "Execution Time": number }];
  }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sqlText}`, params);
  const plan = rows[0]!["QUERY PLAN"][0];
  const relations = new Set<string>();
  collectRelations(plan.Plan, relations);
  return {
    planningTimeMs: plan["Planning Time"],
    executionTimeMs: plan["Execution Time"],
    topNodeType: plan.Plan["Node Type"],
    buffers: sumBuffers(plan.Plan),
    relationsScanned: [...relations].sort(),
    raw: plan,
  };
}

/** Runs `fn` `iterations` times and returns the median of the returned numbers. */
export async function median(iterations: number, fn: () => Promise<number>): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    samples.push(await fn());
  }
  samples.sort((a, b) => a - b);
  const mid = Math.floor(samples.length / 2);
  return samples.length % 2 === 0 ? (samples[mid - 1]! + samples[mid]!) / 2 : samples[mid]!;
}

/** Wall-clock timing of a REAL (non-EXPLAIN) statement, in milliseconds. */
export async function timeStatement(pool: Pool, sqlText: string, params: unknown[] = []): Promise<number> {
  const startedAt = process.hrtime.bigint();
  await pool.query(sqlText, params);
  const endedAt = process.hrtime.bigint();
  return Number(endedAt - startedAt) / 1_000_000;
}

export function bufferTotal(b: PlanBuffers): number {
  return b.sharedHit + b.sharedRead;
}
