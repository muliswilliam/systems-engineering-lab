import type { Pool } from "pg";
import type { createLogger } from "@labs/logging";

type Logger = ReturnType<typeof createLogger>;

/**
 * The subset of an `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` plan node this
 * lab cares about. Postgres's JSON plan has many more fields; only the ones
 * this lab's scenarios read are typed here.
 */
export interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Filter"?: string;
  "Index Cond"?: string;
  "Rows Removed by Filter"?: number;
  "Join Type"?: string;
  /** Planner's ESTIMATE of rows this node will produce. */
  "Plan Rows": number;
  /** Real, measured row count from actually running the query. */
  "Actual Rows": number;
  "Actual Loops": number;
  "Actual Total Time"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  "Shared Dirtied Blocks"?: number;
  "Shared Written Blocks"?: number;
  Plans?: PlanNode[];
}

interface RawExplainJson {
  Plan: PlanNode;
  "Planning Time": number;
  "Execution Time": number;
}

export interface ExplainResult {
  label: string;
  queryText: string;
  planningTimeMs: number;
  executionTimeMs: number;
  /** Every node in the plan tree, flattened, root first. */
  nodes: PlanNode[];
  /** Sum of Shared Hit Blocks across every node - a real measured I/O proxy. */
  totalSharedHitBlocks: number;
  /** Sum of Shared Read Blocks across every node - pages read from disk/OS cache, not Postgres's own buffer cache. */
  totalSharedReadBlocks: number;
  rawPlan: RawExplainJson;
}

function flattenNodes(node: PlanNode): PlanNode[] {
  const children = node.Plans ?? [];
  return [node, ...children.flatMap(flattenNodes)];
}

/**
 * Runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) <query>` - the query is
 * genuinely executed, with real timings, real row counts, and real buffer
 * counts, not planner guesses - and returns a flattened, typed view of the
 * plan tree. JSON format is used instead of text (the way Lab 04 parsed
 * EXPLAIN output) because this lab's whole point is comparing per-node
 * "Plan Rows" (estimate) against "Actual Rows" (reality) and per-node buffer
 * counts precisely - regex-scraping text for that is fragile once a query
 * has more than one or two plan nodes (joins, in particular).
 */
export async function explainAnalyzeJson(
  pool: Pool,
  log: Logger,
  label: string,
  queryText: string,
  params: unknown[] = [],
): Promise<ExplainResult> {
  const result = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${queryText}`, params);
  const raw = result.rows[0]["QUERY PLAN"] as unknown;
  const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as RawExplainJson[];
  const planJson = parsed[0]!;

  const nodes = flattenNodes(planJson.Plan);
  // IMPORTANT: Postgres's per-node Buffers counters are CUMULATIVE, not
  // exclusive - a node's "Shared Hit/Read Blocks" already includes every
  // descendant's buffer usage (verified against this lab's own real EXPLAIN
  // output: a root Sort node's count was within a few pages of its child
  // Aggregate node's count, not the sum of the whole subtree). Summing
  // across ALL nodes would therefore massively OVER-count (double-, triple-,
  // quadruple-counting shared subtrees) - the ROOT node's own count already
  // IS the total for the entire query.
  const totalSharedHitBlocks = nodes[0]?.["Shared Hit Blocks"] ?? 0;
  const totalSharedReadBlocks = nodes[0]?.["Shared Read Blocks"] ?? 0;

  const summary: ExplainResult = {
    label,
    queryText,
    planningTimeMs: planJson["Planning Time"],
    executionTimeMs: planJson["Execution Time"],
    nodes,
    totalSharedHitBlocks,
    totalSharedReadBlocks,
    rawPlan: planJson,
  };

  log.info(
    {
      label,
      planningTimeMs: summary.planningTimeMs,
      executionTimeMs: summary.executionTimeMs,
      totalSharedHitBlocks,
      totalSharedReadBlocks,
      nodes: nodes.map((n) => ({
        nodeType: n["Node Type"],
        relation: n["Relation Name"],
        index: n["Index Name"],
        filter: n["Filter"],
        indexCond: n["Index Cond"],
        planRowsEstimated: n["Plan Rows"],
        actualRows: n["Actual Rows"],
        loops: n["Actual Loops"],
        sharedHitBlocks: n["Shared Hit Blocks"],
        sharedReadBlocks: n["Shared Read Blocks"],
      })),
    },
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) result for: ${label}`,
  );

  return summary;
}

/** Convenience: the top-level (root) node's estimate vs actual row counts. */
export function rootRowEstimateVsActual(result: ExplainResult): { estimated: number; actual: number } {
  const root = result.nodes[0]!;
  return { estimated: root["Plan Rows"], actual: root["Actual Rows"] };
}

/** Finds the first node scanning a given relation (table), if any. */
export function findNodeForRelation(result: ExplainResult, relationName: string): PlanNode | undefined {
  return result.nodes.find((n) => n["Relation Name"] === relationName);
}

/** True if any node in the plan is a sequential scan on the given relation. */
export function hasSeqScanOn(result: ExplainResult, relationName: string): boolean {
  return result.nodes.some((n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] === relationName);
}

/** True if any node in the plan is an index (or index-only, or bitmap) scan using the given index name. */
export function usesIndex(result: ExplainResult, indexName: string): boolean {
  return result.nodes.some((n) => n["Index Name"] === indexName);
}
