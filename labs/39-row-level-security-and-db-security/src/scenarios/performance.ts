import { createLogger } from "@labs/logging";
import { poolFor, withTenantSession, closeAllRolePools } from "../db/roles.js";
import { loadScenarioTenants, firstRow } from "./scenario-lib.js";

const log = createLogger("lab39:scenario:performance");

const RUNS = 5;

interface ExplainResult {
  executionTimeMs: number;
  sharedBuffersHit: number;
  sharedBuffersRead: number;
}

async function explainAnalyze(
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<{ "QUERY PLAN": unknown }> }> },
  sql: string,
  params: unknown[],
): Promise<ExplainResult> {
  const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  const planRow = firstRow(rows);
  const plan = firstRow(planRow["QUERY PLAN"] as unknown[]) as {
    "Execution Time": number;
    Plan: Record<string, unknown>;
  };

  // Postgres's own EXPLAIN (BUFFERS) output reports each node's buffer
  // counters as CUMULATIVE for that node's entire subtree, not exclusive to
  // that node alone (verified directly against this lab's own Postgres 16
  // instance with a two-node join: the parent's "Shared Hit Blocks" equals
  // the sum of its children's) - so the ROOT node's own counters already
  // are the query's total. Recursively summing every node's counters (an
  // earlier version of this function did exactly that) silently
  // double-counts every buffer touched below the root.
  return {
    executionTimeMs: plan["Execution Time"],
    sharedBuffersHit: Number(plan.Plan["Shared Hit Blocks"] ?? 0),
    sharedBuffersRead: Number(plan.Plan["Shared Read Blocks"] ?? 0),
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (firstRow(sorted.slice(mid - 1)) + firstRow(sorted.slice(mid))) / 2;
  }
  return firstRow(sorted.slice(mid));
}

/**
 * PERFORMANCE (README "Tradeoffs"): a Row-Level Security policy is
 * evaluated as an implicit, always-on WHERE clause ANDed onto every query
 * against the table. When the policy's predicate is a simple, indexed
 * equality check (this lab's `tenant_id = current_tenant_id()`, backed by
 * `support_tickets_tenant_id_idx`), Postgres's planner folds it into the
 * SAME index scan an equivalent explicit WHERE clause would use - so the
 * real, measured cost here should be close to zero. This is NOT true in
 * general: a policy predicate that requires a subquery/join per row (e.g.
 * `tenant_id IN (SELECT tenant_id FROM memberships WHERE user_id =
 * current_user_id())`) is NOT index-only and adds real, measurable
 * per-row cost that scales with table size - see README for why this
 * script does not also build that more expensive case (RLS-friendly
 * indexing keeps this lab's own policy cheap by design).
 */
async function main() {
  const { tenantA } = await loadScenarioTenants();
  const migrator = poolFor("migrator");

  const withRls = await withTenantSession("app", tenantA.id, async (client) => {
    const results: ExplainResult[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      results.push(
        await explainAnalyze(client, "SELECT * FROM support_tickets WHERE tenant_id = $1", [tenantA.id]),
      );
    }
    return results;
  });

  log.info("temporarily disabling RLS (as migrator) to measure the same query with zero policy predicate");
  await migrator.query("ALTER TABLE support_tickets DISABLE ROW LEVEL SECURITY");

  let withoutRls: ExplainResult[];
  try {
    withoutRls = await withTenantSession("app", tenantA.id, async (client) => {
      const results: ExplainResult[] = [];
      for (let i = 0; i < RUNS; i += 1) {
        results.push(
          await explainAnalyze(client, "SELECT * FROM support_tickets WHERE tenant_id = $1", [tenantA.id]),
        );
      }
      return results;
    });
  } finally {
    await migrator.query("ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY");
  }

  const withRlsMedianMs = median(withRls.map((r) => r.executionTimeMs));
  const withoutRlsMedianMs = median(withoutRls.map((r) => r.executionTimeMs));
  const withRlsFirst = firstRow(withRls);
  const withoutRlsFirst = firstRow(withoutRls);
  const withRlsBuffers = withRlsFirst.sharedBuffersHit + withRlsFirst.sharedBuffersRead;
  const withoutRlsBuffers = withoutRlsFirst.sharedBuffersHit + withoutRlsFirst.sharedBuffersRead;

  log.info(
    {
      runs: RUNS,
      withRlsMedianMs: Number(withRlsMedianMs.toFixed(3)),
      withoutRlsMedianMs: Number(withoutRlsMedianMs.toFixed(3)),
      withRlsBuffers,
      withoutRlsBuffers,
    },
    "RLS ON vs RLS OFF for an indexed tenant_id equality query - expect these to be close, since the policy predicate is folded into the same index scan an explicit WHERE clause would use",
  );

  await closeAllRolePools();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "scenario:performance failed");
  process.exit(1);
});
