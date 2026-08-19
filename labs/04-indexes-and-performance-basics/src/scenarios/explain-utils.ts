import type { Pool } from "pg";
import type { createLogger } from "@labs/logging";

type Logger = ReturnType<typeof createLogger>;

export interface ExplainSummary {
  label: string;
  planLines: string[];
  hasSeqScan: boolean;
  hasIndexScan: boolean;
  hasIndexOnlyScan: boolean;
  hasBitmapScan: boolean;
  executionTimeMs: number | null;
  rowsReturnedByQuery: number | null;
}

/**
 * Runs `EXPLAIN (ANALYZE, BUFFERS) <query>` (the query is actually executed,
 * with real timings and real row counts - not just planner estimates),
 * parses the plan text for the scan types this lab cares about, and logs
 * both the raw plan and the parsed summary.
 *
 * `EXPLAIN ANALYZE` output only ever returns plan-text rows to the client
 * (one row per line of the plan), never the underlying query's result rows,
 * so this is safe to run even against a query that would otherwise return
 * hundreds of thousands of rows (see the selectivity demo in
 * after-indexing.ts).
 */
export async function explainAnalyze(
  pool: Pool,
  log: Logger,
  label: string,
  queryText: string,
  params: unknown[] = [],
): Promise<ExplainSummary> {
  const result = await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${queryText}`, params);
  const planLines = result.rows.map((row) => row["QUERY PLAN"] as string);
  const planText = planLines.join("\n");

  const executionTimeMatch = planText.match(/Execution Time: ([\d.]+) ms/);
  const rowsMatch = planText.match(/actual time=[\d.]+\.\.[\d.]+ rows=(\d+)/);

  const summary: ExplainSummary = {
    label,
    planLines,
    hasSeqScan: planText.includes("Seq Scan"),
    hasIndexScan: planText.includes("Index Scan") && !planText.includes("Index Only Scan"),
    hasIndexOnlyScan: planText.includes("Index Only Scan"),
    hasBitmapScan: planText.includes("Bitmap"),
    executionTimeMs: executionTimeMatch ? Number(executionTimeMatch[1]) : null,
    rowsReturnedByQuery: rowsMatch ? Number(rowsMatch[1]) : null,
  };

  log.info({ label, plan: planLines }, `EXPLAIN ANALYZE plan for: ${label}`);
  log.info(
    {
      label,
      hasSeqScan: summary.hasSeqScan,
      hasIndexScan: summary.hasIndexScan,
      hasIndexOnlyScan: summary.hasIndexOnlyScan,
      hasBitmapScan: summary.hasBitmapScan,
      executionTimeMs: summary.executionTimeMs,
    },
    `parsed summary for: ${label}`,
  );

  return summary;
}
