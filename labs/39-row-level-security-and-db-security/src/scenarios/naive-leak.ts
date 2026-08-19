import { createLogger } from "@labs/logging";
import { poolFor, withTenantSession, closeAllRolePools } from "../db/roles.js";
import { loadScenarioTenants } from "./scenario-lib.js";
import { forgottenWhereClauseQuery, wrongTenantIdQuery } from "./buggy-queries.js";

const log = createLogger("lab39:scenario:naive-leak");

/**
 * THE BUG (README "Break it"): reproduces a REAL cross-tenant data leak
 * against a REAL Postgres connection, as the shared `app` role, with NO
 * database-level enforcement (Row-Level Security temporarily disabled) -
 * relying entirely on application code to remember `WHERE tenant_id = ?`.
 *
 * This script always leaves the table back in its RLS-ENABLED (secure)
 * state before exiting, even if an assertion/query throws - see the
 * `finally` block. It is meant to be read top to bottom as "here is what
 * goes wrong before the fix", not as a tool you'd run against a real
 * database left in this state.
 */
async function main() {
  const { tenantA, tenantB } = await loadScenarioTenants();
  const migrator = poolFor("migrator");

  log.info(
    { tenantA: tenantA.name, tenantB: tenantB.name },
    "disabling Row-Level Security on support_tickets (as the owning migrator role) to reproduce the pre-RLS naive state",
  );
  await migrator.query("ALTER TABLE support_tickets DISABLE ROW LEVEL SECURITY");

  try {
    // --- Bug #1: forgotten WHERE clause ---
    await withTenantSession("app", tenantA.id, async (client) => {
      const correct = await client.query(
        "SELECT count(*)::int AS count FROM support_tickets WHERE tenant_id = $1",
        [tenantA.id],
      );
      log.info(
        { tenantId: tenantA.id, rows: correct.rows[0].count },
        "control query (correctly filtered) - looks fine, this is what most endpoints do correctly",
      );

      const leaked = await forgottenWhereClauseQuery(client);
      const tenantIds = new Set(leaked.map((r) => r.tenant_id));
      const otherTenantRows = leaked.filter((r) => r.tenant_id !== tenantA.id);

      log.error(
        {
          requestingTenant: tenantA.name,
          totalRowsReturned: leaked.length,
          distinctTenantIdsReturned: tenantIds.size,
          rowsBelongingToOtherTenants: otherTenantRows.length,
          sampleLeakedRow: otherTenantRows[0],
        },
        "REAL LEAK (bug #1, forgotten WHERE clause): a request scoped to one tenant received rows belonging to every tenant in the table",
      );
    });

    // --- Bug #2: WHERE clause present, but the tenant id itself is wrong ---
    await withTenantSession("app", tenantA.id, async (client) => {
      const leaked = await wrongTenantIdQuery(client, tenantB.id);
      log.error(
        {
          requestingTenant: tenantA.name,
          queriedTenantId: tenantB.id,
          queriedTenantName: tenantB.name,
          rowsReturned: leaked.length,
          sampleLeakedRow: leaked[0],
        },
        "REAL LEAK (bug #2, wrong tenant id computed): a request FOR tenant A received tenant B's rows because the WHERE clause's value, not its presence, was the bug",
      );
    });
  } finally {
    log.info("re-enabling Row-Level Security on support_tickets before exiting");
    await migrator.query("ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY");
  }

  await closeAllRolePools();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "scenario:naive-leak failed");
  process.exit(1);
});
